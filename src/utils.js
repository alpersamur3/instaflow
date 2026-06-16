"use strict";

/** Promise-based sleep used to pace actions across the library. */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { delay };
