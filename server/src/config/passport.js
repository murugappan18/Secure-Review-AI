import passport from 'passport';
import { Strategy as GitHubStrategy } from 'passport-github2';
import User from '../models/User.js';

export function configurePassport() {
  const {
    GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET,
    GITHUB_CALLBACK_URL,
  } = process.env;

  if (!GITHUB_CLIENT_ID || !GITHUB_CLIENT_SECRET || !GITHUB_CALLBACK_URL) {
    throw new Error(
      '[passport] missing GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / GITHUB_CALLBACK_URL'
    );
  }

  passport.use(
    new GitHubStrategy(
      {
        clientID: GITHUB_CLIENT_ID,
        clientSecret: GITHUB_CLIENT_SECRET,
        callbackURL: GITHUB_CALLBACK_URL,
        scope: ['repo', 'read:user', 'user:email'],
      },
      async function verify(accessToken, _refreshToken, profile, done) {
        try {
          const githubId = String(profile.id);
          const email =
            profile.emails?.find((e) => e.primary)?.value ??
            profile.emails?.[0]?.value ??
            null;

          let user = await User.findOne({ githubId }).select('+accessToken');

          if (!user) {
            user = new User({
              githubId,
              username: profile.username,
              email,
              avatarUrl: profile.photos?.[0]?.value ?? null,
            });
          } else {
            user.username = profile.username;
            user.email = email;
            user.avatarUrl = profile.photos?.[0]?.value ?? user.avatarUrl;
          }

          user.setAccessToken(accessToken);
          user.lastLoginAt = new Date();
          await user.save();

          return done(null, user);
        } catch (err) {
          return done(err);
        }
      }
    )
  );

  // Passport requires serializeUser/deserializeUser even with session: false,
  // because some strategies still consult them during the auth dance.
  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id, done) => {
    try {
      const user = await User.findById(id);
      done(null, user);
    } catch (err) {
      done(err);
    }
  });
}
