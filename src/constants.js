"use strict";

/**
 * Shared constants for the InstaFlow browser session and rate limiter.
 */

/** Realistic desktop Chrome user-agent used for the persistent browser context. */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Default browser viewport for the Instagram session. */
const VIEWPORT = { width: 1280, height: 720 };

/** Default hourly / daily action caps enforced by the built-in rate limiter. */
const DEFAULT_RATE_LIMITS = {
  post:     { hour: 3,  day: 10  },
  story:    { hour: 5,  day: 15  },
  like:     { hour: 30, day: 150 },
  comment:  { hour: 15, day: 60  },
  follow:   { hour: 10, day: 40  },
  unfollow: { hour: 10, day: 40  },
  dm:       { hour: 10, day: 40  },
};

module.exports = { USER_AGENT, VIEWPORT, DEFAULT_RATE_LIMITS };
