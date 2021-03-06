import * as vscode from "vscode";
import { hasVslsExtension } from "../utils";
import { DiscordChatProvider } from "../discord";
import { SlackChatProvider } from "../slack";
import { VslsChatProvider } from "../vslsChat";
import { ViewsManager } from "./views";
import { ConfigHelper } from "../config";
import { VslsContactProvider } from "./vslsContactProvider";
import { ChatProviderManager } from "./chatManager";
import { SelfCommands } from "../constants";

export default class Manager implements IManager, vscode.Disposable {
  isTokenInitialized: boolean = false;
  viewsManager: ViewsManager;
  vslsContactProvider: VslsContactProvider | undefined;
  chatProviders = new Map<Providers, ChatProviderManager>();

  constructor(public store: IStore) {
    this.viewsManager = new ViewsManager(this);
  }

  getEnabledProviders(): string[] {
    let currentUserInfos = this.store.getCurrentUserForAll();
    let providers: string[] = currentUserInfos.map(
      currentUser => currentUser.provider
    );
    const hasVsls = hasVslsExtension();

    if (hasVsls) {
      providers.push(Providers.vsls);
    }

    // vsls can be added twice: once via currentUserInfo, and
    // then via the VSLS extension availability check
    const uniqueProviders = providers.filter(function(item, pos) {
      return providers.indexOf(item) === pos;
    });
    return uniqueProviders;
  }

  isProviderEnabled(provider: string): boolean {
    const cp = this.chatProviders.get(provider as Providers);
    return !!cp;
  }

  getCurrentTeamFor(provider: string) {
    const currentUser = this.store.getCurrentUser(provider);
    return !!currentUser ? currentUser.currentTeamId : undefined;
  }

  getCurrentUserFor(provider: string) {
    return this.store.getCurrentUser(provider);
  }

  getChatProvider(providerName: Providers) {
    return this.chatProviders.get(providerName);
  }

  instantiateChatProvider(token: string, provider: string): IChatProvider {
    switch (provider) {
      case "discord":
        return new DiscordChatProvider(token, this);
      case "slack":
        return new SlackChatProvider(token, this);
      case "vsls":
        return new VslsChatProvider();
      default:
        throw new Error(`unsupport chat provider: ${provider}`);
    }
  }

  async validateToken(provider: string, token: string) {
    const chatProvider = this.instantiateChatProvider(token, provider);
    const currentUser = await chatProvider.validateToken();
    return currentUser;
  }

  isAuthenticated(providerName: string | undefined): boolean {
    const cp = this.chatProviders.get(providerName as Providers);
    return !!cp ? cp.isAuthenticated() : false;
  }

  initializeToken = async (newProvider?: string) => {
    let enabledProviders = this.getEnabledProviders();

    if (!!newProvider) {
      // In addition to the enabled providers, we will
      // add support for this newProvider
      enabledProviders.push(newProvider);
    }

    for (const provider of enabledProviders) {
      if (!!provider) {
        const token = await ConfigHelper.getToken(provider);

        if (!!token) {
          const existingProvider = this.chatProviders.get(
            provider as Providers
          );

          if (!existingProvider) {
            const chatProvider = this.instantiateChatProvider(token, provider);
            this.chatProviders.set(
              provider as Providers,
              new ChatProviderManager(this.store, provider, chatProvider, this)
            );
          }

          this.isTokenInitialized = true;
        }
      }
    }

    this.initializeViewsManager();
  };

  initializeViewsManager = () => {
    const enabledProviders = Array.from(this.chatProviders.keys());
    let providerTeams: { [provider: string]: Team[] } = {};

    enabledProviders.forEach(provider => {
      const chatProvider = this.chatProviders.get(provider);

      if (!!chatProvider) {
        providerTeams[provider] = chatProvider.getTeams();
      }
    });

    this.viewsManager.initialize(enabledProviders, providerTeams);
  };

  initializeProviders = async (): Promise<any> => {
    for (let entry of Array.from(this.chatProviders.entries())) {
      let chatProvider = entry[1];
      await chatProvider.initializeProvider();
    }
  };

  async initializeUsersStateForAll() {
    for (let entry of Array.from(this.chatProviders.entries())) {
      let chatProvider = entry[1];
      await chatProvider.initializeUsersState();
    }
  }

  async initializeChannelsStateForAll() {
    for (let entry of Array.from(this.chatProviders.entries())) {
      let chatProvider = entry[1];
      await chatProvider.initializeChannelsState();
    }
  }

  subscribePresenceForAll() {
    for (let entry of Array.from(this.chatProviders.entries())) {
      let chatProvider = entry[1];
      chatProvider.subscribeForPresence();
    }
  }

  async updateUserPrefsForAll() {
    for (let entry of Array.from(this.chatProviders.entries())) {
      let chatProvider = entry[1];
      await chatProvider.updateUserPrefs();
    }
  }

  initializeVslsContactProvider = async (): Promise<any> => {
    // This method is called after the users state has been initialized, since
    // the vsls contact provider uses list of users to match with vsls contacts.
    const enabledProviders = this.getEnabledProviders();
    const nonVslsProviders = enabledProviders.filter(
      provider => provider !== "vsls"
    );

    if (hasVslsExtension() && nonVslsProviders.length > 0) {
      const presenceProvider = nonVslsProviders[0]; // we are restricting this to only one
      const isNotAlreadyInit =
        !this.vslsContactProvider || !this.vslsContactProvider.isInitialized;

      const currentUserInfo = this.store.getCurrentUser(presenceProvider);
      const users = this.store.getUsers(presenceProvider);

      if (isNotAlreadyInit && !!currentUserInfo) {
        this.vslsContactProvider = new VslsContactProvider(
          presenceProvider,
          this
        );
        await this.vslsContactProvider.register();

        const userId = currentUserInfo.id;
        const currentUser = users[userId];
        this.vslsContactProvider.notifySelfContact(currentUser);
        this.vslsContactProvider.notifyAvailableUsers(userId, users);
      }
    }
  };

  async signout() {
    // This will sign out of slack and discord. vsls depends only on whether
    // the vsls extension has been installed.
    let hasSignedOut = false;

    for (let entry of Array.from(this.chatProviders.entries())) {
      let providerName = entry[0];

      if (providerName !== "vsls") {
        await ConfigHelper.clearToken(providerName);
        hasSignedOut = true;
      }
    }

    if (hasSignedOut) {
      // When token state is cleared, we need to call reset
      vscode.commands.executeCommand(SelfCommands.RESET_STORE, {
        newProvider: undefined
      });
    }
  }

  clearAll() {
    // This method clears local storage for slack/discord, but not vsls
    const enabledProviders = Array.from(this.chatProviders.keys());

    enabledProviders.forEach(provider => {
      const isNotVsls = provider !== "vsls";

      if (isNotVsls) {
        this.store.clearProviderState(provider);
        const chatProvider = this.chatProviders.get(provider);

        if (!!chatProvider) {
          chatProvider.destroy();
          this.chatProviders.delete(provider);
        }
      }
    });

    this.isTokenInitialized = false;
  }

  clearOldWorkspace(provider: string) {
    // Clears users and channels so that we are loading them again
    this.store.updateUsers(provider, {});
    this.store.updateChannels(provider, []);
    this.store.updateLastChannelId(provider, undefined);
  }

  async updateWebviewForProvider(provider: string, channelId: string) {
    const currentUser = this.store.getCurrentUser(provider);
    const channel = this.store
      .getChannels(provider)
      .find(channel => channel.id === channelId);

    if (!!currentUser && !!channel) {
      await this.store.updateLastChannelId(provider, channelId);
      const users = this.store.getUsers(provider);
      const allMessages = this.getMessages(provider);
      const messages = allMessages[channel.id] || {};

      this.viewsManager.updateWebview(
        currentUser,
        provider,
        users,
        channel,
        messages
      );
    }
  }

  updateStatusItemsForProvider(provider: string) {
    const cp = this.chatProviders.get(provider as Providers);

    if (!!cp) {
      const teams = cp.getTeams();
      teams.forEach(team => {
        this.viewsManager.updateStatusItem(provider, team);
      });
    }
  }

  updateTreeViewsForProvider(provider: string) {
    this.viewsManager.updateTreeViews(provider);
  }

  updateAllUI() {
    const providers = Array.from(this.chatProviders.keys());

    providers.forEach(provider => {
      const lastChannelId = this.store.getLastChannelId(provider);

      if (!!lastChannelId) {
        this.updateWebviewForProvider(provider, lastChannelId);
      }

      this.updateStatusItemsForProvider(provider);
      this.updateTreeViewsForProvider(provider);
    });
  }

  dispose() {
    this.viewsManager.dispose();
  }

  getChannelLabels(provider: string | undefined): ChannelLabel[] {
    // Return channel labels from all providers if input provider is undefined
    let channelLabels: ChannelLabel[] = [];

    for (let entry of Array.from(this.chatProviders.entries())) {
      const cp = entry[1];
      const providerName = entry[0];

      if (!provider || provider === providerName) {
        channelLabels = [...channelLabels, ...cp.getChannelLabels()];
      }
    }

    return channelLabels;
  }

  getUserForId(provider: string, userId: string) {
    return this.store.getUser(provider, userId);
  }

  getIMChannel(provider: string, user: User): Channel | undefined {
    // DM channels look like `name`
    const channels = this.store.getChannels(provider);
    const { name } = user;
    return channels.find(channel => channel.name === name);
  }

  async createIMChannel(
    providerName: string,
    user: User
  ): Promise<Channel | undefined> {
    const cp = this.chatProviders.get(providerName as Providers);
    return !!cp ? cp.createIMChannel(user) : undefined;
  }

  getUserPresence(provider: string, userId: string) {
    const cp = this.chatProviders.get(provider as Providers);
    return !!cp ? cp.getUserPresence(userId) : undefined;
  }

  getCurrentUserPresence = (provider: string) => {
    const cp = this.chatProviders.get(provider as Providers);
    return !!cp ? cp.getCurrentUserPresence() : undefined;
  };

  updateCurrentWorkspace = async (
    provider: string,
    team: Team,
    existingUserInfo: CurrentUser
  ): Promise<void> => {
    const newCurrentUser: CurrentUser = {
      ...existingUserInfo,
      currentTeamId: team.id
    };
    return this.store.updateCurrentUser(provider, newCurrentUser);
  };

  async loadChannelHistory(
    providerName: string,
    channelId: string
  ): Promise<void> {
    const cp = this.chatProviders.get(providerName as Providers);
    return !!cp ? cp.loadChannelHistory(channelId) : undefined;
  }

  async updateReadMarker(providerName: string): Promise<void> {
    const cp = this.chatProviders.get(providerName as Providers);
    return !!cp ? cp.updateReadMarker() : undefined;
  }

  sendMessage = async (
    providerName: string,
    text: string,
    channelId: string,
    parentTimestamp: string | undefined
  ): Promise<void> => {
    const cp = this.chatProviders.get(providerName as Providers);
    return !!cp ? cp.sendMessage(text, channelId, parentTimestamp) : undefined;
  };

  updateSelfPresence = async (
    providerName: string,
    presence: UserPresence,
    durationInMinutes: number
  ) => {
    const cp = this.chatProviders.get(providerName as Providers);
    return !!cp
      ? cp.updateSelfPresence(presence, durationInMinutes)
      : undefined;
  };

  addReaction(
    providerName: string,
    channelId: string,
    msgTimestamp: string,
    userId: string,
    reactionName: string
  ) {
    const cp = this.chatProviders.get(providerName as Providers);
    return !!cp
      ? cp.addReaction(channelId, msgTimestamp, userId, reactionName)
      : undefined;
  }

  removeReaction(
    providerName: string,
    channelId: string,
    msgTimestamp: string,
    userId: string,
    reactionName: string
  ) {
    const cp = this.chatProviders.get(providerName as Providers);
    return !!cp
      ? cp.removeReaction(channelId, msgTimestamp, userId, reactionName)
      : undefined;
  }

  async fetchThreadReplies(providerName: string, parentTimestamp: string) {
    const cp = this.chatProviders.get(providerName as Providers);
    return !!cp ? cp.fetchThreadReplies(parentTimestamp) : undefined;
  }

  updateMessageReply(
    providerName: string,
    parentTimestamp: string,
    channelId: string,
    reply: MessageReply
  ) {
    const cp = this.chatProviders.get(providerName as Providers);
    return !!cp
      ? cp.updateMessageReply(parentTimestamp, channelId, reply)
      : undefined;
  }

  updateMessages(
    providerName: string,
    channelId: string,
    messages: ChannelMessagesWithUndefined
  ) {
    const cp = this.chatProviders.get(providerName as Providers);
    return !!cp ? cp.updateMessages(channelId, messages) : undefined;
  }

  updateChannelMarked(
    provider: string,
    channelId: string,
    readTimestamp: string,
    unreadCount: number
  ) {
    const cp = this.chatProviders.get(provider as Providers);
    return !!cp
      ? cp.updateChannelMarked(channelId, readTimestamp, unreadCount)
      : undefined;
  }

  updatePresenceForUser = (
    providerName: string,
    userId: string,
    presence: UserPresence
  ) => {
    const cp = this.chatProviders.get(providerName as Providers);
    return !!cp ? cp.updatePresenceForUser(userId, presence) : undefined;
  };

  getChannel = (
    provider: string,
    channelId: string | undefined
  ): Channel | undefined => {
    const cp = this.chatProviders.get(provider as Providers);
    return !!cp ? cp.getChannel(channelId) : undefined;
  };

  fetchUsers = (providerName: string) => {
    const cp = this.chatProviders.get(providerName as Providers);
    return !!cp ? cp.fetchUsers() : undefined;
  };

  fetchChannels = (providerName: string) => {
    const cp = this.chatProviders.get(providerName as Providers);
    return !!cp ? cp.fetchChannels() : undefined;
  };

  getMessages = (providerName: string): Messages => {
    const cp = this.chatProviders.get(providerName as Providers);
    return !!cp ? cp.messages : {};
  };

  getUnreadCount = (provider: string, channel: Channel) => {
    const cp = this.chatProviders.get(provider as Providers);
    return !!cp ? cp.getUnreadCount(channel) : 0;
  };
}
