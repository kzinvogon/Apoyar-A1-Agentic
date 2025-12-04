
  // Save Support Settings
  async function saveSupportSettings() {
    const requiresAcceptance = document.getElementById('resolution-requires-acceptance').checked;

    try {
      const tenantCode = window.tenant || 'apoyar';
      const token = localStorage.getItem('token');

      const response = await fetch(`http://localhost:3000/api/tickets/settings/${tenantCode}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          key: 'resolution_requires_acceptance',
          value: requiresAcceptance ? 'true' : 'false'
        })
      });

      const data = await response.json();

      if (data.success) {
        document.getElementById('support-settings-message').textContent = '✅ Settings saved successfully!';
        document.getElementById('support-settings-message').style.display = 'block';
        document.getElementById('support-settings-error').style.display = 'none';
        setTimeout(() => {
          document.getElementById('support-settings-message').style.display = 'none';
        }, 3000);
      } else {
        document.getElementById('support-settings-error').textContent = data.message || 'Error saving settings';
        document.getElementById('support-settings-error').style.display = 'block';
        document.getElementById('support-settings-message').style.display = 'none';
      }
    } catch (error) {
      console.error('Error saving support settings:', error);
      document.getElementById('support-settings-error').textContent = 'Error saving settings';
      document.getElementById('support-settings-error').style.display = 'block';
      document.getElementById('support-settings-message').style.display = 'none';
    }
  }

  // Load Support Settings
  async function loadSupportSettings() {
    try {
      const tenantCode = window.tenant || 'apoyar';
      const token = localStorage.getItem('token');

      const response = await fetch(`http://localhost:3000/api/tickets/settings/${tenantCode}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      const data = await response.json();

      if (data.success && data.settings) {
        const requiresAcceptance = data.settings.resolution_requires_acceptance === 'true';
        document.getElementById('resolution-requires-acceptance').checked = requiresAcceptance;
      }
    } catch (error) {
      console.error('Error loading support settings:', error);
    }
  }
