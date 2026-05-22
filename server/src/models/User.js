import mongoose from 'mongoose';
import { encrypt, decrypt } from '../utils/crypto.js';

const userSchema = new mongoose.Schema(
  {
    githubId: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true },
    email: { type: String, default: null },
    avatarUrl: { type: String, default: null },
    // Stored as AES-256-GCM ciphertext. Use setAccessToken / getAccessToken
    // to read or write the plaintext token. Never returned from toJSON().
    accessToken: { type: String, default: null, select: false },
    lastLoginAt: { type: Date, default: null },
    settings: {
      defaultModel: {
        type: String,
        enum: ['gemini', 'groq', 'claude'],
        default: 'gemini',
      },
      severityThreshold: {
        type: String,
        enum: ['low', 'medium', 'high'],
        default: 'low',
      },
    },
  },
  {
    timestamps: { createdAt: 'createdAt', updatedAt: 'updatedAt' },
    toJSON: {
      transform(_doc, ret) {
        delete ret.accessToken;
        delete ret.__v;
        return ret;
      },
    },
  }
);

userSchema.methods.setAccessToken = function setAccessToken(plain) {
  this.accessToken = encrypt(plain);
};

userSchema.methods.getAccessToken = function getAccessToken() {
  return this.accessToken ? decrypt(this.accessToken) : null;
};

const User = mongoose.model('User', userSchema);
export default User;
