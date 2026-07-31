import { verifyPasswordViaRPC, getCorrectPassword } from './auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { password } = req.body;

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

  let isAuthorized = false;
  if (supabaseUrl && supabaseKey) {
    isAuthorized = await verifyPasswordViaRPC(supabaseUrl, supabaseKey, password);
  }

  if (!isAuthorized) {
    const correctPassword = await getCorrectPassword();
    isAuthorized = (password === correctPassword);
  }

  if (!isAuthorized) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = process.env.VITE_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'Server configuration error: GITHUB_TOKEN missing' });
  }

  const targetRepo = process.env.GITHUB_REPO || 'owner/repository';

  try {
    const response = await fetch(`https://api.github.com/repos/${targetRepo}/dispatches`, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'AutoREADME-Dashboard'
      },
      body: JSON.stringify({
        event_type: 'trigger-readme-improve',
        client_payload: {
          triggered_by: 'dashboard_manual',
          timestamp: new Date().toISOString()
        }
      })
    });

    if (response.status === 204 || response.ok) {
      return res.status(200).json({ success: true });
    } else {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText || 'Failed to dispatch workflow' });
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
