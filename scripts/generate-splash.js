#!/usr/bin/env node

/**
 * iOS Splash Screen Generator
 * Generates splash screens for various iOS device sizes
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const iconsDir = path.join(__dirname, '..', 'icons');

// iOS device splash screen sizes
const splashScreens = [
  { width: 1170, height: 2532, name: 'splash-1170x2532.png' },  // iPhone 12/13/14
  { width: 1284, height: 2778, name: 'splash-1284x2778.png' },  // iPhone 12/13/14 Pro Max
  { width: 1125, height: 2436, name: 'splash-1125x2436.png' },  // iPhone X/XS/11 Pro
  { width: 1242, height: 2688, name: 'splash-1242x2688.png' },  // iPhone XS Max/11 Pro Max
  { width: 828, height: 1792, name: 'splash-828x1792.png' },    // iPhone XR/11
  { width: 1290, height: 2796, name: 'splash-1290x2796.png' },  // iPhone 14 Pro Max
  { width: 1179, height: 2556, name: 'splash-1179x2556.png' },  // iPhone 14 Pro
  { width: 750, height: 1334, name: 'splash-750x1334.png' },    // iPhone 8/SE
  { width: 1242, height: 2208, name: 'splash-1242x2208.png' },  // iPhone 8 Plus
  { width: 640, height: 1136, name: 'splash-640x1136.png' },    // iPhone SE (1st gen)
  { width: 2048, height: 2732, name: 'splash-2048x2732.png' },  // iPad Pro 12.9"
  { width: 1668, height: 2388, name: 'splash-1668x2388.png' },  // iPad Pro 11"
  { width: 1536, height: 2048, name: 'splash-1536x2048.png' },  // iPad Air/Mini
  { width: 1620, height: 2160, name: 'splash-1620x2160.png' },  // iPad 10.2"
];

async function generateSplashScreens() {
  console.log('Generating iOS splash screens...\n');

  for (const screen of splashScreens) {
    const outputPath = path.join(iconsDir, screen.name);

    try {
      // Create a splash screen with ServiFlow branding
      const svg = `
        <svg width="${screen.width}" height="${screen.height}" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" style="stop-color:#003366"/>
              <stop offset="100%" style="stop-color:#0066cc"/>
            </linearGradient>
          </defs>
          <rect width="100%" height="100%" fill="url(#bg)"/>
          <text x="50%" y="45%" font-family="-apple-system, BlinkMacSystemFont, sans-serif"
                font-size="${Math.min(screen.width, screen.height) * 0.08}"
                font-weight="800" fill="white" text-anchor="middle">ServiFlow</text>
          <text x="50%" y="52%" font-family="-apple-system, BlinkMacSystemFont, sans-serif"
                font-size="${Math.min(screen.width, screen.height) * 0.025}"
                fill="rgba(255,255,255,0.8)" text-anchor="middle">Support Platform</text>
        </svg>
      `;

      await sharp(Buffer.from(svg))
        .png()
        .toFile(outputPath);

      console.log(`✓ Generated ${screen.name}`);
    } catch (error) {
      console.error(`✗ Failed to generate ${screen.name}:`, error.message);
    }
  }

  console.log('\nSplash screen generation complete!');
}

generateSplashScreens().catch(console.error);
