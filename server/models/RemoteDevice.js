const mongoose = require('mongoose');

const RemoteDeviceSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
  },
  room: {
    type: String,
    required: true,
  },
  deviceType: {
    type: String,
    default: 'satellite',
  },
  status: {
    type: String,
    enum: ['online', 'offline', 'provisioning', 'error'],
    default: 'provisioning',
  },
  ipAddress: String,
  macAddress: String,
  firmwareVersion: String,
  batteryLevel: Number,
  powerSource: {
    type: String,
    enum: ['battery', 'wired', 'both'],
    default: 'wired',
  },
  uptime: {
    type: Number,
    default: 0,
  },
  lastHeartbeat: {
    type: Date,
    default: null,
  },
  registrationCode: String,
  registrationRequestedAt: Date,
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
}, {
  versionKey: false,
});

RemoteDeviceSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('RemoteDevice', RemoteDeviceSchema);