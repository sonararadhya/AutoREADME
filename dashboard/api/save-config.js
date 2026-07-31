import { verifyPassword, saveConfigInDB } from './auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { key, value, password } = req.body;

  if (!key || value === undefined || !password) {
    return res.status(400).json({ error: 'Missing key, value, or password' });
  }

  try {
    const isAuthorized = await verifyPassword(password);
    if (!isAuthorized) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    await saveConfigInDB(key, value, password);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Failed to save config:', error);
    return res.status(500).json({ error: error.message });
  }
}
