import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const getBody = (req) => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', chunk => { body += chunk.toString(); });
  req.on('end', () => {
    try {
      resolve(body ? JSON.parse(body) : {});
    } catch (e) {
      reject(e);
    }
  });
});

const getCorrectPassword = async (env) => {
  let correctPassword = env.DASHBOARD_PASSWORD || env.VITE_DASHBOARD_PASSWORD || process.env.DASHBOARD_PASSWORD || process.env.VITE_DASHBOARD_PASSWORD;

  const supabaseUrl = env.SUPABASE_URL || env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseKey = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_KEY;

  if (supabaseUrl && supabaseKey) {
    try {
      const resSup = await fetch(`${supabaseUrl}/rest/v1/system_config?key=eq.DASHBOARD_PASSWORD&select=value`, {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        }
      });
      if (resSup.ok) {
        const dataSup = await resSup.json();
        if (dataSup && dataSup[0] && dataSup[0].value) {
          correctPassword = dataSup[0].value;
        }
      }
    } catch (e) {
      console.error('Failed to fetch password from Supabase in dev server:', e);
    }
  }

  return correctPassword || 'admin123';
};

const getDatabaseExpectedPassword = async (env) => {
  const supabaseUrl = env.SUPABASE_URL || env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseKey = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

  if (supabaseUrl && supabaseKey) {
    try {
      const resSup = await fetch(`${supabaseUrl}/rest/v1/system_config?key=eq.DASHBOARD_PASSWORD&select=value`, {
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`
        }
      });
      if (resSup.ok) {
        const dataSup = await resSup.json();
        if (dataSup && dataSup[0] && dataSup[0].value) {
          return dataSup[0].value;
        }
      }
    } catch (e) {
      console.error('Failed to fetch database password from Supabase in dev server:', e);
    }
  }

  return 'admin123';
};

const verifyPassword = async (env, password) => {
  const supabaseUrl = env.SUPABASE_URL || env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseKey = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_KEY || process.env.VITE_SUPABASE_ANON_KEY;

  if (supabaseUrl && supabaseKey) {
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/rpc/update_config_secure`, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          config_key: 'DASHBOARD_PASSWORD',
          config_val: '',
          portal_password: password
        })
      });
      if (!res.ok) {
        const errData = await res.json();
        const errMsg = errData.message || '';
        if (errMsg.includes('Updates to sensitive keys must be done directly')) {
          return true;
        }
      }
    } catch (e) {
      console.error('RPC password verification failed in dev server:', e);
    }
  }

  const correctPassword = await getCorrectPassword(env);
  return password === correctPassword;
};

const configApiPlugin = (env) => ({
  name: 'config-api',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const pathname = url.pathname;
      const targetRepo = env.GITHUB_REPO || process.env.GITHUB_REPO || 'owner/repository';

      if (pathname === '/api/verify' && req.method === 'POST') {
        try {
          const { password } = await getBody(req);
          const isValid = await verifyPassword(env, password);
          if (isValid) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true }));
          } else {
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Unauthorized' }));
          }
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: e.message }));
        }
      } else if (pathname === '/api/trigger' && req.method === 'POST') {
        try {
          const { password } = await getBody(req);
          const isValid = await verifyPassword(env, password);
          if (!isValid) {
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Unauthorized' }));
            return;
          }

          const token = env.VITE_GITHUB_TOKEN || env.GITHUB_TOKEN || process.env.VITE_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
          if (!token) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Server GITHUB_TOKEN not configured' }));
            return;
          }

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
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true }));
          } else {
            const errText = await response.text();
            res.statusCode = response.status;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: errText || 'Failed to dispatch workflow' }));
          }
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: e.message }));
        }
      } else {
        next();
      }
    });
  }
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '');
  return {
    plugins: [react(), configApiPlugin(env)],
  };
})
