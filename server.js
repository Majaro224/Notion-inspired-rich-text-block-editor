const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ─── Seed data ───────────────────────────────────────────────────────────────

const workspaces = {
  acme: {
    id: 'acme',
    name: 'Acme Corp',
    icon: 'A',
    color: '#5865f2',
    channels: [
      { id: 'general', name: 'general', type: 'channel' },
      { id: 'engineering', name: 'engineering', type: 'channel' },
      { id: 'design', name: 'design', type: 'channel' },
      { id: 'random', name: 'random', type: 'channel' },
    ],
    dms: [
      { id: 'dm-alice', name: 'Alice Chen', type: 'dm', avatar: 'AC' },
      { id: 'dm-bob', name: 'Bob Rivera', type: 'dm', avatar: 'BR' },
      { id: 'dm-carol', name: 'Carol Kim', type: 'dm', avatar: 'CK' },
    ],
  },
  startup: {
    id: 'startup',
    name: 'Startup Hub',
    icon: 'S',
    color: '#3ba55d',
    channels: [
      { id: 'announcements', name: 'announcements', type: 'channel' },
      { id: 'product', name: 'product', type: 'channel' },
      { id: 'growth', name: 'growth', type: 'channel' },
    ],
    dms: [
      { id: 'dm-dave', name: 'Dave Patel', type: 'dm', avatar: 'DP' },
      { id: 'dm-eve', name: 'Eve Santos', type: 'dm', avatar: 'ES' },
    ],
  },
  creative: {
    id: 'creative',
    name: 'Creative Studio',
    icon: 'C',
    color: '#faa61a',
    channels: [
      { id: 'showcase', name: 'showcase', type: 'channel' },
      { id: 'feedback', name: 'feedback', type: 'channel' },
    ],
    dms: [
      { id: 'dm-frank', name: 'Frank Lee', type: 'dm', avatar: 'FL' },
    ],
  },
};

const messageHistory = {};
const activeUsers = {};
const typingUsers = {};

function channelKey(workspaceId, channelId) {
  return `${workspaceId}:${channelId}`;
}

function seedMessages() {
  const seeds = [
    { ws: 'acme', ch: 'general', user: 'Alice Chen', text: 'Good morning everyone! ☀️', ago: 3600000 },
    { ws: 'acme', ch: 'general', user: 'Bob Rivera', text: 'Morning Alice! Ready for the standup?', ago: 3500000 },
    { ws: 'acme', ch: 'general', user: 'Carol Kim', text: 'I pushed the latest design mocks to Figma.', ago: 1800000 },
    { ws: 'acme', ch: 'engineering', user: 'Bob Rivera', text: 'PR #142 is ready for review.', ago: 7200000 },
    { ws: 'acme', ch: 'engineering', user: 'Alice Chen', text: 'On it — will review after lunch.', ago: 7000000 },
    { ws: 'acme', ch: 'design', user: 'Carol Kim', text: 'New color palette is live in the design system.', ago: 5400000 },
    { ws: 'acme', ch: 'random', user: 'Bob Rivera', text: 'Anyone up for coffee at 3?', ago: 900000 },
    { ws: 'startup', ch: 'announcements', user: 'Dave Patel', text: 'We hit 10k users this week! 🎉', ago: 86400000 },
    { ws: 'startup', ch: 'product', user: 'Eve Santos', text: 'Roadmap update: mobile app in Q3.', ago: 43200000 },
    { ws: 'creative', ch: 'showcase', user: 'Frank Lee', text: 'Check out the new brand identity!', ago: 21600000 },
  ];

  seeds.forEach((s, i) => {
    const key = channelKey(s.ws, s.ch);
    if (!messageHistory[key]) messageHistory[key] = [];
    messageHistory[key].push({
      id: `seed-${i}`,
      workspaceId: s.ws,
      channelId: s.ch,
      userId: s.user.toLowerCase().replace(/\s/g, '-'),
      username: s.user,
      text: s.text,
      timestamp: Date.now() - s.ago,
    });
  });
}

seedMessages();

// Initialize active user maps per workspace
Object.keys(workspaces).forEach((wsId) => {
  activeUsers[wsId] = new Map();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getWorkspaceList() {
  return Object.values(workspaces).map(({ id, name, icon, color }) => ({
    id, name, icon, color,
  }));
}

function getWorkspaceData(workspaceId) {
  const ws = workspaces[workspaceId];
  if (!ws) return null;
  return {
    id: ws.id,
    name: ws.name,
    channels: ws.channels,
    dms: ws.dms,
    activeUsers: Array.from(activeUsers[workspaceId]?.values() || []),
  };
}

function getChannelHistory(workspaceId, channelId, limit = 50) {
  const key = channelKey(workspaceId, channelId);
  const messages = messageHistory[key] || [];
  return messages.slice(-limit);
}

function addMessage(workspaceId, channelId, userId, username, text) {
  const key = channelKey(workspaceId, channelId);
  if (!messageHistory[key]) messageHistory[key] = [];

  const message = {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    workspaceId,
    channelId,
    userId,
    username,
    text,
    timestamp: Date.now(),
  };

  messageHistory[key].push(message);
  if (messageHistory[key].length > 500) {
    messageHistory[key] = messageHistory[key].slice(-500);
  }

  return message;
}

function getActiveUsersList(workspaceId) {
  return Array.from(activeUsers[workspaceId]?.values() || []);
}

function setTyping(workspaceId, channelId, userId, username, isTyping) {
  const key = channelKey(workspaceId, channelId);
  if (!typingUsers[key]) typingUsers[key] = new Map();

  if (isTyping) {
    typingUsers[key].set(userId, { userId, username });
  } else {
    typingUsers[key].delete(userId);
  }

  return Array.from(typingUsers[key].values());
}

// ─── Socket.io ───────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  let currentUser = null;
  let currentWorkspace = null;
  let currentChannel = null;

  socket.on('user:join', ({ username, workspaceId }) => {
    if (!username?.trim() || !workspaces[workspaceId]) return;

    currentUser = {
      id: socket.id,
      username: username.trim(),
      avatar: username.trim().split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase(),
      status: 'online',
      joinedAt: Date.now(),
    };
    currentWorkspace = workspaceId;

    activeUsers[workspaceId].set(socket.id, currentUser);
    socket.join(`workspace:${workspaceId}`);

    socket.emit('init', {
      user: currentUser,
      workspaces: getWorkspaceList(),
      workspace: getWorkspaceData(workspaceId),
    });

    io.to(`workspace:${workspaceId}`).emit('users:update', {
      workspaceId,
      users: getActiveUsersList(workspaceId),
    });
  });

  socket.on('workspace:switch', ({ workspaceId }) => {
    if (!currentUser || !workspaces[workspaceId]) return;

    if (currentWorkspace) {
      activeUsers[currentWorkspace].delete(socket.id);
      socket.leave(`workspace:${currentWorkspace}`);
      io.to(`workspace:${currentWorkspace}`).emit('users:update', {
        workspaceId: currentWorkspace,
        users: getActiveUsersList(currentWorkspace),
      });
    }

    currentWorkspace = workspaceId;
    activeUsers[workspaceId].set(socket.id, currentUser);
    socket.join(`workspace:${workspaceId}`);

    socket.emit('workspace:data', getWorkspaceData(workspaceId));
    io.to(`workspace:${workspaceId}`).emit('users:update', {
      workspaceId,
      users: getActiveUsersList(workspaceId),
    });
  });

  socket.on('channel:join', ({ workspaceId, channelId }) => {
    if (!currentUser || !workspaces[workspaceId]) return;

    if (currentChannel) {
      socket.leave(`channel:${channelKey(currentWorkspace, currentChannel)}`);
      setTyping(currentWorkspace, currentChannel, currentUser.id, currentUser.username, false);
    }

    currentChannel = channelId;
    const key = channelKey(workspaceId, channelId);
    socket.join(`channel:${key}`);

    const history = getChannelHistory(workspaceId, channelId);
    socket.emit('channel:history', {
      workspaceId,
      channelId,
      messages: history,
    });

    socket.emit('channel:typing', {
      workspaceId,
      channelId,
      users: setTyping(workspaceId, channelId, currentUser.id, currentUser.username, false),
    });
  });

  socket.on('message:send', ({ workspaceId, channelId, text }) => {
    if (!currentUser || !text?.trim()) return;

    const message = addMessage(
      workspaceId,
      channelId,
      currentUser.id,
      currentUser.username,
      text.trim()
    );

    setTyping(workspaceId, channelId, currentUser.id, currentUser.username, false);

    io.to(`channel:${channelKey(workspaceId, channelId)}`).emit('message:new', message);
  });

  socket.on('typing:start', ({ workspaceId, channelId }) => {
    if (!currentUser) return;

    const users = setTyping(workspaceId, channelId, currentUser.id, currentUser.username, true);
    socket.to(`channel:${channelKey(workspaceId, channelId)}`).emit('channel:typing', {
      workspaceId,
      channelId,
      users,
    });
  });

  socket.on('typing:stop', ({ workspaceId, channelId }) => {
    if (!currentUser) return;

    const users = setTyping(workspaceId, channelId, currentUser.id, currentUser.username, false);
    socket.to(`channel:${channelKey(workspaceId, channelId)}`).emit('channel:typing', {
      workspaceId,
      channelId,
      users,
    });
  });

  socket.on('disconnect', () => {
    if (currentUser && currentWorkspace) {
      activeUsers[currentWorkspace].delete(socket.id);

      if (currentChannel) {
        setTyping(currentWorkspace, currentChannel, currentUser.id, currentUser.username, false);
        io.to(`channel:${channelKey(currentWorkspace, currentChannel)}`).emit('channel:typing', {
          workspaceId: currentWorkspace,
          channelId: currentChannel,
          users: Array.from(typingUsers[channelKey(currentWorkspace, currentChannel)]?.values() || []),
        });
      }

      io.to(`workspace:${currentWorkspace}`).emit('users:update', {
        workspaceId: currentWorkspace,
        users: getActiveUsersList(currentWorkspace),
      });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Workspace Chat running at http://localhost:${PORT}`);
});
