import { verifyPasswordViaRPC, getCorrectPassword } from './auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { password } = req.body;

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

  let isValid = false;
  if (supabaseUrl && supabaseKey) {
    isValid = await verifyPasswordViaRPC(supabaseUrl, supabaseKey, password);
  }

  if (!isValid) {
    const correctPassword = await getCorrectPassword();
    isValid = (password === correctPassword);
  }

  if (isValid) {
    return res.status(200).json({ success: true });
  } else {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}
