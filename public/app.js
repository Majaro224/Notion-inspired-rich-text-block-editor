/* global io */

(function () {
  'use strict';

  // ─── State ─────────────────────────────────────────────────────────────────

  const state = {
    user: null,
    workspaces: [],
    workspace: null,
    activeChannel: null,
    activeUsers: [],
    typingUsers: [],
    isNearBottom: true,
    isLoadingHistory: false,
    lastMessageAuthor: null,
    lastMessageTime: 0,
  };

  const SCROLL_THRESHOLD = 80;
  const COMPACT_WINDOW_MS = 5 * 60 * 1000;
  const TYPING_DEBOUNCE_MS = 300;
  const TYPING_STOP_MS = 2000;

  let socket = null;
  let typingTimer = null;
  let typingStopTimer = null;
  let isTyping = false;

  // ─── DOM refs ──────────────────────────────────────────────────────────────

  const $ = (sel) => document.querySelector(sel);

  const dom = {
    loginOverlay: $('#login-overlay'),
    loginForm: $('#login-form'),
    usernameInput: $('#username-input'),
    app: $('#app'),
    workspaceList: $('#workspace-list'),
    workspaceName: $('#workspace-name'),
    channelList: $('#channel-list'),
    dmList: $('#dm-list'),
    activeUsersList: $('#active-users-list'),
    activeCount: $('#active-count'),
    userAvatar: $('#user-avatar'),
    userName: $('#user-name'),
    emptyState: $('#empty-state'),
    conversationPanel: $('#conversation-panel'),
    channelHash: $('#channel-hash'),
    channelName: $('#channel-name'),
    messagesScroll: $('#messages-scroll'),
    messagesList: $('#messages-list'),
    scrollBottomBtn: $('#scroll-bottom-btn'),
    typingIndicator: $('#typing-indicator'),
    typingText: $('#typing-text'),
    messageForm: $('#message-form'),
    messageInput: $('#message-input'),
    sendBtn: document.querySelector('.composer-send'),
  };

  // ─── Utilities ─────────────────────────────────────────────────────────────

  function avatarColor(name) {
    const colors = ['#5865f2', '#3ba55d', '#faa61a', '#ed4245', '#eb459e', '#57f287'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  }

  function initials(name) {
    return name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (isToday) return `Today at ${time}`;
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `Yesterday at ${time}`;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` at ${time}`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── Scroll management (no viewport jumps) ─────────────────────────────────

  function getScrollMetrics() {
    const el = dom.messagesScroll;
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      distanceFromBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
    };
  }

  function isUserNearBottom() {
    return getScrollMetrics().distanceFromBottom <= SCROLL_THRESHOLD;
  }

  function updateNearBottomState() {
    state.isNearBottom = isUserNearBottom();
    dom.scrollBottomBtn.classList.toggle('hidden', state.isNearBottom);
  }

  function scrollToBottom(smooth) {
    const el = dom.messagesScroll;
    const target = el.scrollHeight;

    if (smooth) {
      el.scrollTo({ top: target, behavior: 'smooth' });
    } else {
      el.scrollTop = target;
    }

    state.isNearBottom = true;
    dom.scrollBottomBtn.classList.add('hidden');
  }

  /**
   * Append content while preserving scroll position when the user
   * has scrolled up to read history.
   */
  function appendWithScrollPreservation(appendFn) {
    const el = dom.messagesScroll;
    const wasNearBottom = isUserNearBottom();
    const prevScrollHeight = el.scrollHeight;

    appendFn();

    requestAnimationFrame(() => {
      if (wasNearBottom || state.isLoadingHistory === false) {
        if (wasNearBottom) {
          el.scrollTop = el.scrollHeight;
          state.isNearBottom = true;
          dom.scrollBottomBtn.classList.add('hidden');
        } else {
          const heightDiff = el.scrollHeight - prevScrollHeight;
          el.scrollTop += heightDiff;
        }
      }
      updateNearBottomState();
    });
  }

  // ─── Message rendering ─────────────────────────────────────────────────────

  function shouldCompact(msg) {
    return (
      state.lastMessageAuthor === msg.username &&
      msg.timestamp - state.lastMessageTime < COMPACT_WINDOW_MS
    );
  }

  function createMessageElement(msg, options = {}) {
    const { animate = false, compact = false } = options;
    const isOwn = state.user && msg.userId === state.user.id;
    const color = avatarColor(msg.username);

    const group = document.createElement('div');
    group.className = 'message-group';
    group.dataset.messageId = msg.id;
    if (compact) group.classList.add('compact');
    if (isOwn) group.classList.add('is-own');
    if (animate) group.classList.add('message-new');

    group.innerHTML = `
      <div class="message-avatar">
        <div class="message-avatar-circle" style="background:${color}">${initials(msg.username)}</div>
      </div>
      <div class="message-body">
        <div class="message-header">
          <span class="message-author">${escapeHtml(msg.username)}</span>
          <span class="message-time">${formatTime(msg.timestamp)}</span>
        </div>
        <div class="message-text">${escapeHtml(msg.text)}</div>
      </div>
    `;

    return group;
  }

  function renderMessages(messages, clearFirst) {
    if (clearFirst) {
      dom.messagesList.innerHTML = '';
      state.lastMessageAuthor = null;
      state.lastMessageTime = 0;
    }

    const fragment = document.createDocumentFragment();
    let prevAuthor = state.lastMessageAuthor;
    let prevTime = state.lastMessageTime;

    messages.forEach((msg) => {
      const compact =
        prevAuthor === msg.username &&
        msg.timestamp - prevTime < COMPACT_WINDOW_MS;

      fragment.appendChild(createMessageElement(msg, { compact }));
      prevAuthor = msg.username;
      prevTime = msg.timestamp;
    });

    if (messages.length > 0) {
      const last = messages[messages.length - 1];
      state.lastMessageAuthor = last.username;
      state.lastMessageTime = last.timestamp;
    }

    dom.messagesList.appendChild(fragment);
  }

  function appendMessage(msg, animate) {
    const compact = shouldCompact(msg);

    appendWithScrollPreservation(() => {
      dom.messagesList.appendChild(
        createMessageElement(msg, { animate, compact })
      );
    });

    state.lastMessageAuthor = msg.username;
    state.lastMessageTime = msg.timestamp;
  }

  // ─── UI updates ────────────────────────────────────────────────────────────

  function renderWorkspaces() {
    dom.workspaceList.innerHTML = '';
    state.workspaces.forEach((ws) => {
      const btn = document.createElement('button');
      btn.className = 'workspace-btn';
      btn.style.background = ws.color;
      btn.textContent = ws.icon;
      btn.title = ws.name;
      btn.dataset.workspaceId = ws.id;
      if (state.workspace && state.workspace.id === ws.id) {
        btn.classList.add('active');
      }
      btn.addEventListener('click', () => switchWorkspace(ws.id));
      dom.workspaceList.appendChild(btn);
    });
  }

  function renderDirectory() {
    if (!state.workspace) return;

    dom.workspaceName.textContent = state.workspace.name;
    dom.channelList.innerHTML = '';
    dom.dmList.innerHTML = '';

    state.workspace.channels.forEach((ch) => {
      const li = document.createElement('li');
      li.className = 'channel-item';
      li.dataset.channelId = ch.id;
      li.dataset.type = 'channel';
      li.innerHTML = `<span class="channel-prefix">#</span><span>${escapeHtml(ch.name)}</span>`;
      if (state.activeChannel && state.activeChannel.id === ch.id && state.activeChannel.type === 'channel') {
        li.classList.add('active');
      }
      li.addEventListener('click', () => joinChannel(ch));
      dom.channelList.appendChild(li);
    });

    state.workspace.dms.forEach((dm) => {
      const li = document.createElement('li');
      li.className = 'channel-item';
      li.dataset.channelId = dm.id;
      li.dataset.type = 'dm';
      const color = avatarColor(dm.name);
      li.innerHTML = `
        <span class="dm-avatar" style="background:${color}">${escapeHtml(dm.avatar)}</span>
        <span>${escapeHtml(dm.name)}</span>
      `;
      if (state.activeChannel && state.activeChannel.id === dm.id) {
        li.classList.add('active');
      }
      li.addEventListener('click', () => joinChannel(dm));
      dom.dmList.appendChild(li);
    });
  }

  function renderActiveUsers() {
    dom.activeUsersList.innerHTML = '';
    dom.activeCount.textContent = state.activeUsers.length;

    state.activeUsers.forEach((u) => {
      const li = document.createElement('li');
      li.className = 'active-user-item';
      li.innerHTML = `
        <span class="active-user-dot"></span>
        <span>${escapeHtml(u.username)}</span>
      `;
      dom.activeUsersList.appendChild(li);
    });
  }

  function showConversation(channel) {
    dom.emptyState.classList.add('hidden');
    dom.conversationPanel.classList.remove('hidden');

    const isDm = channel.type === 'dm';
    dom.channelHash.textContent = isDm ? '@' : '#';
    dom.channelName.textContent = channel.name;
    dom.messageInput.placeholder = isDm
      ? `Message ${channel.name}`
      : `Message #${channel.name}`;
  }

  function updateTypingIndicator() {
    const others = state.typingUsers.filter(
      (u) => state.user && u.userId !== state.user.id
    );

    if (others.length === 0) {
      dom.typingIndicator.classList.add('hidden');
      return;
    }

    let text;
    if (others.length === 1) {
      text = `${others[0].username} is typing…`;
    } else if (others.length === 2) {
      text = `${others[0].username} and ${others[1].username} are typing…`;
    } else {
      text = 'Several people are typing…';
    }

    dom.typingText.textContent = text;
    dom.typingIndicator.classList.remove('hidden');
  }

  // ─── Channel / workspace actions ───────────────────────────────────────────

  function switchWorkspace(workspaceId) {
    if (state.workspace && state.workspace.id === workspaceId) return;
    socket.emit('workspace:switch', { workspaceId });
    state.activeChannel = null;
    dom.conversationPanel.classList.add('hidden');
    dom.emptyState.classList.remove('hidden');
    dom.messagesList.innerHTML = '';
    clearTyping();
  }

  function joinChannel(channel) {
    if (
      state.activeChannel &&
      state.activeChannel.id === channel.id
    ) return;

    state.activeChannel = channel;
    state.isLoadingHistory = true;
    state.lastMessageAuthor = null;
    state.lastMessageTime = 0;

    showConversation(channel);
    renderDirectory();
    dom.messagesList.innerHTML = '';
    clearTyping();

    socket.emit('channel:join', {
      workspaceId: state.workspace.id,
      channelId: channel.id,
    });
  }

  function sendMessage(text) {
    if (!text.trim() || !state.activeChannel || !state.workspace) return;

    socket.emit('message:send', {
      workspaceId: state.workspace.id,
      channelId: state.activeChannel.id,
      text: text.trim(),
    });

    stopTyping();
    dom.messageInput.value = '';
    dom.messageInput.style.height = 'auto';
    dom.sendBtn.disabled = true;
  }

  // ─── Typing indicators ─────────────────────────────────────────────────────

  function clearTyping() {
    state.typingUsers = [];
    updateTypingIndicator();
    stopTyping();
  }

  function startTyping() {
    if (!state.activeChannel || !state.workspace || isTyping) return;
    isTyping = true;
    socket.emit('typing:start', {
      workspaceId: state.workspace.id,
      channelId: state.activeChannel.id,
    });
  }

  function stopTyping() {
    if (!isTyping) return;
    isTyping = false;
    if (state.activeChannel && state.workspace) {
      socket.emit('typing:stop', {
        workspaceId: state.workspace.id,
        channelId: state.activeChannel.id,
      });
    }
    clearTimeout(typingStopTimer);
    clearTimeout(typingTimer);
  }

  function handleTypingInput() {
    clearTimeout(typingStopTimer);
    clearTimeout(typingTimer);

    typingTimer = setTimeout(startTyping, TYPING_DEBOUNCE_MS);
    typingStopTimer = setTimeout(stopTyping, TYPING_STOP_MS);
  }

  // ─── Socket event handlers ─────────────────────────────────────────────────

  function setupSocket() {
    socket = io();

    socket.on('init', (data) => {
      state.user = data.user;
      state.workspaces = data.workspaces;
      state.workspace = data.workspace;
      state.activeUsers = data.workspace.activeUsers;

      dom.userAvatar.textContent = data.user.avatar;
      dom.userName.textContent = data.user.username;

      renderWorkspaces();
      renderDirectory();
      renderActiveUsers();

      dom.loginOverlay.classList.add('hidden');
      dom.app.classList.remove('hidden');

      const firstChannel = data.workspace.channels[0];
      if (firstChannel) joinChannel(firstChannel);
    });

    socket.on('workspace:data', (data) => {
      state.workspace = data;
      state.activeUsers = data.activeUsers;
      renderWorkspaces();
      renderDirectory();
      renderActiveUsers();
    });

    socket.on('users:update', ({ workspaceId, users }) => {
      if (state.workspace && state.workspace.id === workspaceId) {
        state.activeUsers = users;
        renderActiveUsers();
      }
    });

    socket.on('channel:history', ({ messages }) => {
      state.isLoadingHistory = true;
      renderMessages(messages, true);

      requestAnimationFrame(() => {
        scrollToBottom(false);
        state.isLoadingHistory = false;
        state.isNearBottom = true;
      });
    });

    socket.on('message:new', (msg) => {
      if (
        !state.activeChannel ||
        msg.channelId !== state.activeChannel.id
      ) return;

      const wasNearBottom = isUserNearBottom();
      const isOwnMessage = state.user && msg.userId === state.user.id;

      appendMessage(msg, true);

      if (wasNearBottom || isOwnMessage) {
        requestAnimationFrame(() => scrollToBottom(isOwnMessage));
      }
    });

    socket.on('channel:typing', ({ channelId, users }) => {
      if (state.activeChannel && state.activeChannel.id === channelId) {
        state.typingUsers = users;
        updateTypingIndicator();
      }
    });
  }

  // ─── Event listeners ───────────────────────────────────────────────────────

  function setupEvents() {
    dom.loginForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const username = dom.usernameInput.value.trim();
      if (!username) return;

      if (!socket) setupSocket();

      socket.emit('user:join', {
        username,
        workspaceId: 'acme',
      });
    });

    dom.messageForm.addEventListener('submit', (e) => {
      e.preventDefault();
      sendMessage(dom.messageInput.value);
    });

    dom.messageInput.addEventListener('input', () => {
      dom.sendBtn.disabled = !dom.messageInput.value.trim();
      autoResizeTextarea();
      handleTypingInput();
    });

    dom.messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (dom.messageInput.value.trim()) {
          sendMessage(dom.messageInput.value);
        }
      }
    });

    dom.messagesScroll.addEventListener('scroll', () => {
      updateNearBottomState();
    }, { passive: true });

    dom.scrollBottomBtn.addEventListener('click', () => {
      scrollToBottom(true);
    });
  }

  function autoResizeTextarea() {
    const ta = dom.messageInput;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }

  // ─── Boot ──────────────────────────────────────────────────────────────────

  setupEvents();
  dom.usernameInput.focus();
})();
