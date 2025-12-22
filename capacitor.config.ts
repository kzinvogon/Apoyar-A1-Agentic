import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.serviflow.app',
  appName: 'ServiFlow',
  webDir: 'www',

  // Server configuration for development
  server: {
    // Use your production URL for the app
    url: 'https://www.serviflow.app',
    cleartext: true,
    // For local development, uncomment and use:
    // url: 'http://localhost:3000',
  },

  // iOS specific configuration
  ios: {
    contentInset: 'automatic',
    preferredContentMode: 'mobile',
    scheme: 'ServiFlow',
    backgroundColor: '#1a1a2e',
  },

  // Android specific configuration
  android: {
    backgroundColor: '#1a1a2e',
    allowMixedContent: true,
  },

  // Plugins configuration
  plugins: {
    SplashScreen: {
      launchShowDuration: 2000,
      launchAutoHide: true,
      backgroundColor: '#1a1a2e',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: true,
      spinnerColor: '#4f46e5',
      iosSpinnerStyle: 'large',
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: 'dark',
      backgroundColor: '#1a1a2e',
    },
  },
};

export default config;
