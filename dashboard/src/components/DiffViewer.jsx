import { useState, useEffect } from 'react';

export default function DiffViewer({ commitUrl }) {
  const [diffText, setDiffText] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!commitUrl) return;

    let isMounted = true;

    async function fetchDiff() {
      setLoading(true);
      setError(null);
      setDiffText(null);

      try {
        const urlObj = new URL(commitUrl);
        const parts = urlObj.pathname.split('/').filter(Boolean);
        
        if (parts.length < 4 || parts[2] !== 'commit') {
          throw new Error('Invalid GitHub commit URL format');
        }

        const owner = parts[0];
        const repo = parts[1];
        const sha = parts[3];

        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${sha}`);
        
        if (!response.ok) {
          throw new Error(`GitHub API returned ${response.status}: ${response.statusText}`);
        }

        const commitData = await response.json();
        
        if (!commitData.files || commitData.files.length === 0) {
          throw new Error('No files found in this commit.');
        }

        const targetFile = commitData.files.find(f => f.filename.toLowerCase().includes('readme.md')) || commitData.files[0];

        if (!targetFile.patch) {
          throw new Error('No diff patch available for this file.');
        }

        if (isMounted) setDiffText(targetFile.patch);
      } catch (err) {
        console.error(err);
        if (isMounted) setError(err.message || 'Failed to fetch diff from GitHub.');
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    fetchDiff();

    return () => {
      isMounted = false;
    };
  }, [commitUrl]);

  if (loading) {
    return <div className="spinner" style={{ width: '30px', height: '30px', borderWidth: '2px' }}></div>;
  }

  if (error) {
    return (
      <div style={{ color: 'var(--danger)', marginTop: '20px', padding: '16px', background: 'var(--danger-bg)', borderRadius: '8px' }}>
        <strong>Error:</strong> {error}
      </div>
    );
  }

  if (!diffText) return null;

  const lines = diffText.split('\n');

  return (
    <div className="code-block">
      {lines.map((line, idx) => {
        let lineClass = 'diff-line';
        if (line.startsWith('+')) {
          lineClass += ' addition';
        } else if (line.startsWith('-')) {
          lineClass += ' deletion';
        } else if (line.startsWith('@@')) {
          lineClass += ' header-line';
        }

        return (
          <div key={idx} className={lineClass}>
            {line || ' '}
          </div>
        );
      })}
    </div>
  );
}
