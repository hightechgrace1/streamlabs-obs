import Vue from 'vue';
import defer from 'lodash/defer';
import { PersistentStatefulService } from 'services/core/persistent-stateful-service';
import { Inject } from 'services/core/injector';
import { handleResponse, authorizedHeaders } from 'util/requests';
import { mutation } from 'services/core/stateful-service';
import { Service } from 'services/core';
import electron from 'electron';
import { HostsService } from 'services/hosts';
import { IncrementalRolloutService } from 'services/incremental-rollout';
import { PlatformAppsService } from 'services/platform-apps';
import {
  getPlatformService,
  IUserAuth,
  TPlatform,
  IPlatformService,
  EPlatformCallResult,
  IPlatformAuth,
} from 'services/platforms';
import { CustomizationService } from 'services/customization';
import * as Sentry from '@sentry/browser';
import { RunInLoadingMode } from 'services/app/app-decorators';
import { SceneCollectionsService } from 'services/scene-collections';
import { Subject } from 'rxjs';
import Utils from 'services/utils';
import { WindowsService } from 'services/windows';
import { $t, I18nService } from 'services/i18n';
import uuid from 'uuid/v4';
import { OnboardingService } from 'services/onboarding';
import { NavigationService } from 'services/navigation';
import { SettingsService } from 'services/settings';
import * as obs from '../../../obs-api';
import { StreamSettingsService } from 'services/settings/streaming';
import { lazyModule } from 'util/lazy-module';
import { AuthModule } from './auth-module';

interface ISecondaryPlatformAuth {
  username: string;
  token: string;
  id: string;
}

export enum EAuthProcessState {
  Idle = 'idle',
  Busy = 'busy',
}

// Eventually we will support authing multiple platforms at once
interface IUserServiceState {
  loginValidated: boolean;
  auth?: IUserAuth;
  authProcessState: EAuthProcessState;
}

interface ILinkedPlatform {
  access_token: string;
  platform_id: string;
  platform_name: string;
}

interface ILinkedPlatformsResponse {
  twitch_account?: ILinkedPlatform;
  facebook_account?: ILinkedPlatform;
  youtube_account?: ILinkedPlatform;
  mixer_account?: ILinkedPlatform;
}

export type LoginLifecycleOptions = {
  init: () => Promise<void>;
  destroy: () => Promise<void>;
  context: Service;
};

export type LoginLifecycle = {
  destroy: () => Promise<void>;
};

interface ISentryContext {
  username: string;
  platform: string;
}

export function setSentryContext(ctx: ISentryContext) {
  Sentry.configureScope(scope => {
    scope.setUser({ username: ctx.username });
    scope.setExtra('platform', ctx.platform);
  });

  if (Utils.isMainWindow()) {
    obs.NodeObs.SetUsername(ctx.username);
  }
}

export class UserService extends PersistentStatefulService<IUserServiceState> {
  @Inject() private hostsService: HostsService;
  @Inject() private customizationService: CustomizationService;
  @Inject() private sceneCollectionsService: SceneCollectionsService;
  @Inject() private windowsService: WindowsService;
  @Inject() private onboardingService: OnboardingService;
  @Inject() private navigationService: NavigationService;
  @Inject() private incrementalRolloutService: IncrementalRolloutService;
  @Inject() private settingsService: SettingsService;
  @Inject() private streamSettingsService: StreamSettingsService;

  @mutation()
  LOGIN(auth: IUserAuth) {
    Vue.set(this.state, 'auth', auth);

    // For now, to ensure safe rollbacks, we will set the old format
    Vue.set(this.state.auth, 'platform', auth.platforms[auth.primaryPlatform]);
  }

  @mutation()
  UPDATE_PLATFORM(auth: IPlatformAuth) {
    Vue.set(this.state.auth.platforms, auth.type, auth);
  }

  @mutation()
  UNLINK_PLATFORM(platform: TPlatform) {
    Vue.delete(this.state.auth.platforms, platform);
  }

  @mutation()
  LOGOUT() {
    Vue.delete(this.state, 'auth');
  }

  @mutation()
  private SET_PLATFORM_TOKEN(platform: TPlatform, token: string) {
    this.state.auth.platforms[platform].token = token;
  }

  @mutation()
  private SET_CHANNEL_ID(platform: TPlatform, id: string) {
    this.state.auth.platforms[platform].channelId = id;
  }

  @mutation()
  private SET_USERNAME(platform: TPlatform, name: string) {
    this.state.auth.platforms[platform].channelId = name;
  }

  @mutation()
  private VALIDATE_LOGIN(validated: boolean) {
    Vue.set(this.state, 'loginValidated', validated);
  }

  @mutation()
  private SET_AUTH_STATE(state: EAuthProcessState) {
    Vue.set(this.state, 'authProcessState', state);
  }

  /**
   * Checks for v1 auth schema and migrates if needed
   */
  @mutation()
  private MIGRATE_AUTH() {
    if (!this.state.auth) return;

    if (this.state.auth.platform && !this.state.auth.platforms) {
      Vue.set(this.state.auth, 'platforms', {
        [this.state.auth.platform.type]: this.state.auth.platform,
      });
      Vue.set(this.state.auth, 'primaryPlatform', this.state.auth.platform.type);

      // We are not deleting the old key for now to ensure compatibility
      // in the case we have to roll back. Eventually we should remove it.
    }
  }

  userLogin = new Subject<IUserAuth>();
  userLogout = new Subject();

  /**
   * Used by child and 1-off windows to update their sentry contexts
   */
  sentryContext = new Subject<ISentryContext>();

  @lazyModule(AuthModule) private authModule: AuthModule;

  init() {
    super.init();
    this.MIGRATE_AUTH();
    this.VALIDATE_LOGIN(false);
    this.SET_AUTH_STATE(EAuthProcessState.Idle);
  }

  mounted() {
    // This is used for faking authentication in tests.  We have
    // to do this because Twitch adds a captcha when we try to
    // actually log in from integration tests.
    electron.ipcRenderer.on(
      'testing-fakeAuth',
      async (e: Electron.Event, auth: IUserAuth, isOnboardingTest: boolean) => {
        const service = getPlatformService(auth.primaryPlatform);
        this.streamSettingsService.resetStreamSettings();
        await this.login(service, auth);
        if (!isOnboardingTest) this.onboardingService.finish();
      },
    );
  }

  // Makes sure the user's login is still good
  async validateLogin() {
    if (!this.state.auth) return;

    const host = this.hostsService.streamlabs;
    const headers = authorizedHeaders(this.apiToken);
    const url = `https://${host}/api/v5/slobs/validate`;
    const request = new Request(url, { headers });

    const valid = await fetch(request).then(res => {
      return res.text();
    });

    if (valid.match(/false/)) {
      this.LOGOUT();
      electron.remote.dialog.showMessageBox({
        message: $t('You have been logged out'),
      });
      return;
    }

    const service = getPlatformService(this.state.auth.primaryPlatform);
    await this.login(service, this.state.auth);
  }

  /**
   * Attempt to update user info via API.  This is mainly
   * to support name changes on Twitch.
   */
  async refreshUserInfo() {
    if (!this.isLoggedIn) return;

    // Make a best attempt to refresh the user data
    try {
      const service = getPlatformService(this.platform.type);
      const userInfo = await service.fetchUserInfo();

      if (userInfo.username) {
        this.SET_USERNAME(this.platform.type, userInfo.username);
      }
    } catch (e) {
      console.error('Error fetching user info', e);
    }
  }

  async updateLinkedPlatforms() {
    const linkedPlatforms = await this.fetchLinkedPlatforms();

    // TODO: Could metaprogram this a bit more
    if (linkedPlatforms.facebook_account) {
      this.UPDATE_PLATFORM({
        type: 'facebook',
        username: linkedPlatforms.facebook_account.platform_name,
        id: linkedPlatforms.facebook_account.platform_id,
        token: linkedPlatforms.facebook_account.access_token,
      });
    } else if (this.state.auth.primaryPlatform !== 'facebook') {
      this.UNLINK_PLATFORM('facebook');
    }

    if (linkedPlatforms.mixer_account) {
      this.UPDATE_PLATFORM({
        type: 'mixer',
        username: linkedPlatforms.mixer_account.platform_name,
        id: linkedPlatforms.mixer_account.platform_id,
        token: linkedPlatforms.mixer_account.access_token,
      });
    } else if (this.state.auth.primaryPlatform !== 'mixer') {
      this.UNLINK_PLATFORM('mixer');
    }

    if (linkedPlatforms.twitch_account) {
      this.UPDATE_PLATFORM({
        type: 'twitch',
        username: linkedPlatforms.twitch_account.platform_name,
        id: linkedPlatforms.twitch_account.platform_id,
        token: linkedPlatforms.twitch_account.access_token,
      });
    } else if (this.state.auth.primaryPlatform !== 'twitch') {
      this.UNLINK_PLATFORM('twitch');
    }

    if (linkedPlatforms.youtube_account) {
      this.UPDATE_PLATFORM({
        type: 'youtube',
        username: linkedPlatforms.youtube_account.platform_name,
        id: linkedPlatforms.youtube_account.platform_id,
        token: linkedPlatforms.youtube_account.access_token,
      });
    } else if (this.state.auth.primaryPlatform !== 'youtube') {
      this.UNLINK_PLATFORM('youtube');
    }
  }

  fetchLinkedPlatforms(): Promise<ILinkedPlatformsResponse> {
    if (!this.isLoggedIn) return;

    const host = this.hostsService.streamlabs;
    const headers = authorizedHeaders(this.apiToken);
    const url = `https://${host}/api/v5/restream/user/info`;
    const request = new Request(url, { headers });

    return fetch(request)
      .then(res => {
        return res.json();
      })
      .catch(() => {});
  }

  /**
   * Attempts to flush the user's session to disk if it exists
   */
  flushUserSession(): Promise<void> {
    if (this.isLoggedIn && this.state.auth.partition) {
      return new Promise(resolve => {
        const session = electron.remote.session.fromPartition(this.state.auth.partition);

        session.flushStorageData();
        session.cookies.flushStore(resolve);
      });
    }

    return Promise.resolve();
  }

  get isLoggedIn() {
    return !!(this.state.auth && this.state.auth.widgetToken && this.state.loginValidated);
  }

  /**
   * This is a uuid that persists across the application lifetime and uniquely
   * identifies this particular installation of slobs, even when the user is
   * not logged in.
   */
  getLocalUserId() {
    const localStorageKey = 'SlobsLocalUserId';
    let userId = localStorage.getItem(localStorageKey);

    if (!userId) {
      userId = uuid();
      localStorage.setItem(localStorageKey, userId);
    }

    return userId;
  }

  get apiToken() {
    if (this.state.auth) return this.state.auth.apiToken;
  }

  get widgetToken() {
    if (this.isLoggedIn) {
      return this.state.auth.widgetToken;
    }
  }

  /**
   * Returns the auth for the primary platform
   */
  get platform() {
    if (this.isLoggedIn) {
      return this.state.auth.platforms[this.state.auth.primaryPlatform];
    }
  }

  get platformType(): TPlatform {
    if (this.isLoggedIn) {
      return this.state.auth.primaryPlatform;
    }
  }

  get username() {
    if (this.isLoggedIn) {
      return this.platform.username;
    }
  }

  get platformId() {
    if (this.isLoggedIn) {
      return this.platform.id;
    }
  }

  get channelId() {
    if (this.isLoggedIn) {
      return this.platform.channelId;
    }
  }

  recentEventsUrl() {
    if (this.isLoggedIn) {
      const host = this.hostsService.streamlabs;
      const token = this.widgetToken;
      const nightMode = this.customizationService.isDarkTheme ? 'night' : 'day';
      const isMediaShare =
        this.windowsService.state.RecentEvents &&
        this.windowsService.state.RecentEvents.queryParams.isMediaShare
          ? '&view=media-share'
          : '';

      return `https://${host}/dashboard/recent-events?token=${token}&mode=${nightMode}&electron${isMediaShare}`;
    }
  }

  dashboardUrl(subPage: string, hidenav: boolean = false) {
    const token = this.apiToken;
    const nightMode = this.customizationService.isDarkTheme ? 'night' : 'day';
    const hideNav = hidenav ? 'true' : 'false';
    const i18nService = I18nService.instance as I18nService; // TODO: replace with getResource('I18nService')
    const locale = i18nService.state.locale;
    // eslint-disable-next-line
    return `https://${
      this.hostsService.streamlabs
    }/slobs/dashboard?oauth_token=${token}&mode=${nightMode}&r=${subPage}&l=${locale}&hidenav=${hideNav}`;
  }

  appStoreUrl(appId?: string) {
    const host = this.hostsService.platform;
    const token = this.apiToken;
    const nightMode = this.customizationService.isDarkTheme ? 'night' : 'day';
    let url = `https://${host}/slobs-store`;

    if (appId) {
      url = `${url}/app/${appId}`;
    }

    return `${url}?token=${token}&mode=${nightMode}`;
  }

  overlaysUrl(type?: 'overlay' | 'widget-theme', id?: string) {
    const uiTheme = this.customizationService.isDarkTheme ? 'night' : 'day';
    let url = `https://${this.hostsService.streamlabs}/library?mode=${uiTheme}&slobs`;

    if (this.isLoggedIn) {
      url += `&oauth_token=${this.apiToken}`;
    }

    if (type && id) {
      url += `#/?type=${type}&id=${id}`;
    }

    return url;
  }

  getDonationSettings() {
    const host = this.hostsService.streamlabs;
    const url = `https://${host}/api/v5/slobs/donation/settings`;
    const headers = authorizedHeaders(this.apiToken);
    const request = new Request(url, { headers });

    return fetch(request).then(handleResponse);
  }

  async showLogin() {
    if (this.isLoggedIn) await this.logOut();
    this.onboardingService.start({ isLogin: true });
  }

  @RunInLoadingMode()
  private async login(service: IPlatformService, auth: IUserAuth) {
    this.LOGIN(auth);
    this.VALIDATE_LOGIN(true);
    await this.updateLinkedPlatforms();
    const result = await service.validatePlatform();

    // Currently we treat generic errors as success
    if (result === EPlatformCallResult.TwitchTwoFactor) {
      this.LOGOUT();
      return result;
    }

    if (result === EPlatformCallResult.TwitchScopeMissing) {
      await this.logOut();
      this.showLogin();

      electron.remote.dialog.showMessageBox(electron.remote.getCurrentWindow(), {
        type: 'warning',
        title: 'Twitch Error',
        message: $t(
          $t('Your Twitch login is expired. Please log in again to continue using Streamlabs OBS'),
        ),
        buttons: [$t('Refresh Login')],
      });

      return result;
    }

    this.refreshUserInfo();
    this.setSentryContext();

    this.userLogin.next(auth);
    await this.sceneCollectionsService.setupNewUser();

    return result;
  }

  @RunInLoadingMode()
  async logOut() {
    // Attempt to sync scense before logging out
    await this.sceneCollectionsService.save();
    await this.sceneCollectionsService.safeSync();
    // Navigate away from disabled tabs on logout
    this.navigationService.navigate('Studio');

    const session = this.state.auth.partition
      ? electron.remote.session.fromPartition(this.state.auth.partition)
      : electron.remote.session.defaultSession;

    session.clearStorageData({ storages: ['cookies'] });
    this.settingsService.setSettingValue('Stream', 'key', '');

    this.LOGOUT();
    this.userLogout.next();
  }

  /**
   * Starts the authentication process.  Multiple callbacks
   * can be passed for various events.
   */
  async startAuth(
    platform: TPlatform,
    mode: 'internal' | 'external',
    merge = false,
  ): Promise<EPlatformCallResult> {
    const service = getPlatformService(platform);
    const authUrl =
      merge && service.supports('account-merging') ? service.mergeUrl : service.authUrl;

    if (merge && !this.isLoggedIn) {
      throw new Error('Account merging can only be performed while logged in');
    }

    this.SET_AUTH_STATE(EAuthProcessState.Busy);
    const onWindowShow = () => this.SET_AUTH_STATE(EAuthProcessState.Idle);

    const auth =
      mode === 'internal'
        /* eslint-disable */
        ? await this.authModule.startInternalAuth(
          authUrl,
          service.authWindowOptions,
          onWindowShow,
          merge,
        )
        : await this.authModule.startExternalAuth(authUrl, onWindowShow, merge);
        /* eslint-enable */

    this.SET_AUTH_STATE(EAuthProcessState.Busy);

    let result: EPlatformCallResult;

    if (!merge) {
      // Ensure we are starting with fresh stream settings
      this.streamSettingsService.resetStreamSettings();

      result = await this.login(service, auth);
    } else {
      this.UPDATE_PLATFORM(auth.platforms[auth.primaryPlatform]);
      result = EPlatformCallResult.Success;
    }

    this.SET_AUTH_STATE(EAuthProcessState.Idle);
    return result;
  }

  updatePlatformToken(platform: TPlatform, token: string) {
    this.SET_PLATFORM_TOKEN(platform, token);
  }

  updatePlatformChannelId(platform: TPlatform, id: string) {
    this.SET_CHANNEL_ID(platform, id);
  }

  /**
   * Registers the current user information with Sentry so
   * we can view more detailed information.
   */
  setSentryContext() {
    if (!this.isLoggedIn) return;

    setSentryContext(this.getSentryContext());

    this.sentryContext.next(this.getSentryContext());
  }

  getSentryContext(): ISentryContext {
    if (!this.isLoggedIn) return null;

    return {
      username: this.username,
      platform: this.platform.type,
    };
  }

  /**
   * Abstracts a common pattern of performing an action if the user is logged in, listening for user
   * login events to perform that action at the point the user logs in, and doing cleanup on logout.
   *
   * @param init A function to be performed immediately if the user is logged in, and on every login
   * @param destroy A function to be performed when the user logs out
   * @param context `this` binding
   * @returns An object with a `destroy` method that will perform cleanup (including un-subscribing
   * from login events), typically invoked on a Service's `destroyed` method.
   * @example
   * class ChatService extends Service {
   *   @Inject() userService: UserService;
   *
   *   init() {
   *     this.lifecycle = this.userService.withLifecycle({
   *       init: this.initChat,
   *       destroy: this.deinitChat,
   *       context: this,
   *     })
   *   }
   *
   *   async initChat() { ... }
   *   async deinitChat() { ... }
   *
   *   async destroyed() {
   *     this.lifecycle.destroy();
   *   }
   * }
   */
  async withLifecycle({ init, destroy, context }: LoginLifecycleOptions): Promise<LoginLifecycle> {
    const doInit = init.bind(context);
    const doDestroy = destroy.bind(context);

    const userLoginSubscription = this.userLogin.subscribe(() => doInit());
    const userLogoutSubscription = this.userLogout.subscribe(() => doDestroy());

    if (this.isLoggedIn) {
      await doInit();
    }

    return {
      destroy: async () => {
        userLoginSubscription.unsubscribe();
        userLogoutSubscription.unsubscribe();
        await doDestroy();
      },
    } as LoginLifecycle;
  }
}
