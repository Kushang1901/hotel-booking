const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Save Chrome inside the project directory so it's always found by Render
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
