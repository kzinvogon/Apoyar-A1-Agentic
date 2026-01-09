#!/usr/bin/env node

/**
 * Creates a sideloadable Teams app manifest.zip
 *
 * Usage: npm run manifest
 *
 * Requires:
 * - MICROSOFT_APP_ID environment variable or in .env file
 * - manifest/manifest.json template
 * - manifest/icon-color.png (192x192)
 * - manifest/icon-outline.png (32x32)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MANIFEST_DIR = path.join(__dirname, '..', 'manifest');
const OUTPUT_FILE = path.join(__dirname, '..', 'manifest.zip');

// Required files
const REQUIRED_FILES = [
  'manifest.json',
  'icon-color.png',
  'icon-outline.png'
];

function createManifest() {
  console.log('Creating Teams app manifest...\n');

  // Check for Microsoft App ID
  const appId = process.env.MICROSOFT_APP_ID;
  if (!appId) {
    console.error('Error: MICROSOFT_APP_ID not set.');
    console.error('Set it in .env file or as environment variable.\n');
    console.error('Example:');
    console.error('  MICROSOFT_APP_ID=12345678-1234-1234-1234-123456789012\n');
    process.exit(1);
  }

  // Check manifest directory exists
  if (!fs.existsSync(MANIFEST_DIR)) {
    console.error(`Error: Manifest directory not found: ${MANIFEST_DIR}`);
    process.exit(1);
  }

  // Check required files exist
  const missingFiles = [];
  for (const file of REQUIRED_FILES) {
    const filePath = path.join(MANIFEST_DIR, file);
    if (!fs.existsSync(filePath)) {
      missingFiles.push(file);
    }
  }

  if (missingFiles.length > 0) {
    console.error('Error: Missing required files in manifest folder:');
    missingFiles.forEach(f => console.error(`  - ${f}`));
    console.error('\nRequired files:');
    console.error('  - manifest.json (Teams app manifest template)');
    console.error('  - icon-color.png (192x192 color icon)');
    console.error('  - icon-outline.png (32x32 outline icon)');
    process.exit(1);
  }

  // Read and process manifest.json
  const manifestPath = path.join(MANIFEST_DIR, 'manifest.json');
  let manifestContent = fs.readFileSync(manifestPath, 'utf8');

  // Replace placeholders
  manifestContent = manifestContent.replace(/\{\{MICROSOFT_APP_ID\}\}/g, appId);

  // Write processed manifest to temp file
  const tempManifestPath = path.join(MANIFEST_DIR, 'manifest.processed.json');
  fs.writeFileSync(tempManifestPath, manifestContent);

  // Remove old zip if exists
  if (fs.existsSync(OUTPUT_FILE)) {
    fs.unlinkSync(OUTPUT_FILE);
  }

  // Create zip file
  try {
    // Change to manifest directory and create zip
    const originalDir = process.cwd();
    process.chdir(MANIFEST_DIR);

    // Rename processed manifest temporarily
    fs.renameSync('manifest.processed.json', 'manifest.temp.json');
    fs.renameSync('manifest.json', 'manifest.original.json');
    fs.renameSync('manifest.temp.json', 'manifest.json');

    // Create zip with required files
    execSync(`zip -j "${OUTPUT_FILE}" manifest.json icon-color.png icon-outline.png`, {
      stdio: 'pipe'
    });

    // Restore original manifest
    fs.renameSync('manifest.json', 'manifest.processed.json');
    fs.renameSync('manifest.original.json', 'manifest.json');
    fs.unlinkSync('manifest.processed.json');

    process.chdir(originalDir);

    console.log(`Successfully created: ${OUTPUT_FILE}\n`);
    console.log('Next steps:');
    console.log('1. Open Microsoft Teams');
    console.log('2. Go to Apps > Manage your apps');
    console.log('3. Click "Upload an app" > "Upload a custom app"');
    console.log('4. Select the generated manifest.zip\n');

    // Validate manifest
    const processedManifest = JSON.parse(manifestContent);
    console.log('Manifest details:');
    console.log(`  App ID: ${processedManifest.id}`);
    console.log(`  Name: ${processedManifest.name.short}`);
    console.log(`  Version: ${processedManifest.version}`);

  } catch (error) {
    console.error('Error creating zip file:', error.message);
    console.error('\nMake sure the "zip" command is available on your system.');
    process.exit(1);
  }
}

// Create placeholder icons if they don't exist
function ensureIcons() {
  const colorIcon = path.join(MANIFEST_DIR, 'icon-color.png');
  const outlineIcon = path.join(MANIFEST_DIR, 'icon-outline.png');

  if (!fs.existsSync(colorIcon) || !fs.existsSync(outlineIcon)) {
    console.log('Note: Icon files not found.');
    console.log('Creating placeholder icons...\n');
    console.log('For production, replace with your actual icons:');
    console.log('  - icon-color.png: 192x192 PNG with brand colors');
    console.log('  - icon-outline.png: 32x32 PNG outline/monochrome\n');

    // Create minimal valid PNG (1x1 blue pixel for color, white for outline)
    // PNG header + IHDR + IDAT + IEND for a 1x1 image
    // This is a minimal placeholder - should be replaced with real icons

    if (!fs.existsSync(colorIcon)) {
      // Minimal blue PNG
      const bluePng = Buffer.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
        0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, // IDAT chunk
        0x54, 0x08, 0xD7, 0x63, 0x60, 0x60, 0xF8, 0x0F,
        0x00, 0x01, 0x01, 0x01, 0x00, 0x18, 0xDD, 0x8D,
        0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, // IEND chunk
        0x44, 0xAE, 0x42, 0x60, 0x82
      ]);
      fs.writeFileSync(colorIcon, bluePng);
      console.log('  Created placeholder icon-color.png');
    }

    if (!fs.existsSync(outlineIcon)) {
      // Minimal white PNG
      const whitePng = Buffer.from([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
        0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
        0x54, 0x08, 0xD7, 0x63, 0xF8, 0xFF, 0xFF, 0x3F,
        0x00, 0x05, 0xFE, 0x02, 0xFE, 0xDC, 0xCC, 0x59,
        0xE7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
        0x44, 0xAE, 0x42, 0x60, 0x82
      ]);
      fs.writeFileSync(outlineIcon, whitePng);
      console.log('  Created placeholder icon-outline.png');
    }
    console.log('');
  }
}

// Run
ensureIcons();
createManifest();
