const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const http = require('http');
require('dotenv').config();

const { connectDB } = require('./config/database');

// Create Express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

// Connect to DB (but don't crash the whole process if missing during first run)
connectDB();

// Basic routes
app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok' });
});

// Placeholder auth routes to allow client to proceed during initial setup
// In a full implementation, replace with real auth logic and JWT issuance
app.post('/api/auth/register', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }
  // Return demo tokens and user payload so client can continue
  res.json({
    accessToken: 'demo-access-token',
    refreshToken: 'demo-refresh-token',
    email,
    role: 'user'
  });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }
  res.json({
    accessToken: 'demo-access-token',
    refreshToken: 'demo-refresh-token',
    email,
    role: 'user'
  });
});

// Start HTTP server
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`HomeBrain API listening on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
