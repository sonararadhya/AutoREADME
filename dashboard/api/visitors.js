import { verifyPassword } from './auth.js';

export default async function handler(req, res) {
  const rawUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

  if (!rawUrl || !supabaseKey) {
    return res.status(500).json({ error: 'Supabase credentials missing on server' });
  }

  const supabaseUrl = rawUrl.replace(/\/+$/, '');

  // 1. Handle POST (Insert visitor telemetry)
  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const payload = {
        country: body?.country || 'India',
        device: body?.device || 'Linux Laptop/Desktop',
        browser: body?.browser || 'Chrome',
        os: body?.os || 'Linux',
        page: body?.page || '/'
      };

      const resp = await fetch(`${supabaseUrl}/rest/v1/visitors`, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(payload)
      });

      if (resp.ok) {
        const data = await resp.json();
        return res.status(200).json({ success: true, data });
      } else {
        const errText = await resp.text();
        return res.status(resp.status).json({ error: errText });
      }
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // 2. Handle GET (Fetch visitor telemetry logs)
  if (req.method === 'GET') {
    const tables = ['visitors', 'visitors_ist'];
    const sortColumns = ['id', 'created_at', 'created_at_ist'];

    for (const table of tables) {
      for (const col of sortColumns) {
        try {
          const resp = await fetch(`${supabaseUrl}/rest/v1/${table}?select=*&order=${col}.desc&limit=150`, {
            headers: {
              'apikey': supabaseKey,
              'Authorization': `Bearer ${supabaseKey}`,
              'Accept': 'application/json'
            }
          });
          if (resp.ok) {
            const data = await resp.json();
            if (Array.isArray(data)) {
              return res.status(200).json({ data });
            }
          }
        } catch (e) {
          console.error(`Error querying ${table} by ${col}:`, e);
        }
      }
    }

    return res.status(200).json({ data: [] });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
