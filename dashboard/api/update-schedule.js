import { verifyPasswordViaRPC, getCorrectPassword } from './auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { password, numRuns } = req.body;

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
    const refRes = await fetch(`https://api.github.com/repos/${targetRepo}/git/ref/heads/main?t=${Date.now()}`, {
      cache: 'no-store',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'RepoSonar-Dashboard'
      }
    });

    if (!refRes.ok) {
      throw new Error(`Failed to fetch main branch ref: ${refRes.statusText}`);
    }

    const refData = await refRes.json();
    const latestCommitSha = refData.object.sha;

    const getRes = await fetch(`https://api.github.com/repos/${targetRepo}/contents/.github/workflows/auto-improve.yml?ref=${latestCommitSha}&t=${Date.now()}`, {
      cache: 'no-store',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'RepoSonar-Dashboard'
      }
    });

    if (!getRes.ok) {
      throw new Error(`Failed to fetch workflow file: ${getRes.statusText}`);
    }

    const data = await getRes.json();
    const content = Buffer.from(data.content, 'base64').toString('utf8');

    const crons = [];
    if (numRuns === 1) {
      crons.push('    - cron: "30 12 * * *"');
    } else if (numRuns === 2) {
      crons.push('    - cron: "30 8 * * *"');
      crons.push('    - cron: "30 20 * * *"');
    } else if (numRuns === 3) {
      crons.push('    - cron: "30 4 * * *"');
      crons.push('    - cron: "30 12 * * *"');
      crons.push('    - cron: "30 20 * * *"');
    } else if (numRuns === 4) {
      crons.push('    - cron: "30 0 * * *"');
      crons.push('    - cron: "30 6 * * *"');
      crons.push('    - cron: "30 12 * * *"');
      crons.push('    - cron: "30 18 * * *"');
    }

    const newCronBlock = '  schedule:\n' + crons.join('\n');
    const updatedContent = content.replace(/  schedule:\s*(?:\s*-\s*cron:\s*"[^"]*")+/, newCronBlock);
    const encodedContent = Buffer.from(updatedContent, 'utf8').toString('base64');

    let putRes = await fetch(`https://api.github.com/repos/${targetRepo}/contents/.github/workflows/auto-improve.yml`, {
      method: 'PUT',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'RepoSonar-Dashboard'
      },
      body: JSON.stringify({
        message: `chore: Update automation runs to ${numRuns} per day`,
        content: encodedContent,
        sha: data.sha,
        branch: 'main'
      })
    });

    if (!putRes.ok) {
      const errText = await putRes.text();
      const match = errText.match(/is at ([a-f0-9]{40}) but expected/i);
      if (putRes.status === 409 && match && match[1]) {
        const correctSha = match[1];
        putRes = await fetch(`https://api.github.com/repos/${targetRepo}/contents/.github/workflows/auto-improve.yml`, {
          method: 'PUT',
          headers: {
            'Accept': 'application/vnd.github.v3+json',
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'RepoSonar-Dashboard'
          },
          body: JSON.stringify({
            message: `chore: Update automation runs to ${numRuns} per day`,
            content: encodedContent,
            sha: correctSha,
            branch: 'main'
          })
        });
      } else {
        return res.status(putRes.status).json({ error: errText || 'Failed to update workflow file' });
      }
    }

    if (putRes.ok) {
      return res.status(200).json({ success: true });
    } else {
      const errText = await putRes.text();
      return res.status(putRes.status).json({ error: errText || 'Failed to update workflow file on retry' });
    }
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
