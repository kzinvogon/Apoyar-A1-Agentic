#!/usr/bin/env node

/**
 * Icon Generator Script
 * Generates PNG icons from SVG for PWA
 * Uses sharp library for high-quality SVG to PNG conversion
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

// All icon sizes needed for PWA + iOS
const sizes = [72, 96, 128, 144, 152, 167, 180, 192, 384, 512];
const iconsDir = path.join(__dirname, '..', 'icons');
const svgPath = path.join(iconsDir, 'icon.svg');

async function generateIcons() {
  console.log('Generating PNG icons from SVG...\n');

  // Check if SVG exists
  if (!fs.existsSync(svgPath)) {
    console.error('Error: icon.svg not found at', svgPath);
    process.exit(1);
  }

  // Read the SVG file
  const svgBuffer = fs.readFileSync(svgPath);

  // Generate icons for each size
  for (const size of sizes) {
    const outputPath = path.join(iconsDir, `icon-${size}x${size}.png`);

    try {
      await sharp(svgBuffer)
        .resize(size, size)
        .png()
        .toFile(outputPath);

      console.log(`✓ Generated icon-${size}x${size}.png`);
    } catch (error) {
      console.error(`✗ Failed to generate icon-${size}x${size}.png:`, error.message);
    }
  }

  console.log('\nIcon generation complete!');
  console.log(`Icons saved to: ${iconsDir}`);
}

generateIcons().catch(console.error);
