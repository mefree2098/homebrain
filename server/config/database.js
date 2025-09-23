const mongoose = require('mongoose');
require('dotenv').config();

const connectDB = async () => {
  try {
    // Support both DATABASE_URL and MONGODB_URI, with a sensible default
    const uri = process.env.DATABASE_URL || process.env.MONGODB_URI || 'mongodb://localhost:27017/homebrain';
    if (!uri) {
      throw new Error('No MongoDB connection string found in env (DATABASE_URL or MONGODB_URI)');
    }

    const conn = await mongoose.connect(uri);

    console.log(`MongoDB Connected: ${conn.connection.host}/${conn.connection.name}`);

    // Error handling after initial connection
    mongoose.connection.on('error', err => {
      console.error(`MongoDB connection error: ${err}`);
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('MongoDB disconnected. Attempting to reconnect...');
    });

    mongoose.connection.on('reconnected', () => {
      console.info('MongoDB reconnected');
    });
  } catch (error) {
    console.error(`MongoDB connection failed (continuing without DB): ${error.message}`);
    // Do NOT exit the process; allow API to run with in-memory data for dev
  }
};

const closeDB = async () => {
  if (mongoose.connection.readyState === 0) {
    return;
  }
  try {
    await mongoose.connection.close();
    console.log('MongoDB connection closed');
  } catch (err) {
    console.error('Error closing MongoDB connection:', err);
  }
};

module.exports = {
  connectDB,
  closeDB,
};
