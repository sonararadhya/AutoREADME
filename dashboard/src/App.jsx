import { useState, useEffect } from 'react';
import { GitBranch, FileText, ArrowLeftRight, Clock, AlertCircle, BarChart2, Activity, Cpu, ShieldAlert, Zap, ChevronRight, LayoutGrid, Radar, Battery, Power, Settings, Eye, EyeOff, KeyRound, Fingerprint, Users, Globe, Search, RefreshCw } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, BarChart, Bar, LineChart, Line } from 'recharts';
import DiffViewer from './components/DiffViewer';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || import.meta.env.SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_KEY || import.meta.env.SUPABASE_KEY || import.meta.env.SUPABASE_ANON_KEY || '';

let supabase = null;
if (supabaseUrl && supabaseAnonKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseAnonKey);
  } catch (e) {
    console.error('[RepoSonar] Failed to initialize Supabase client:', e);
  }
}

const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <div className="glass-panel" style={{ padding: '16px', border: '1px solid var(--accent-primary)', boxShadow: '0 0 20px rgba(168, 85, 247, 0.2)', backgroundColor: 'rgba(12, 10, 26, 0.9)' }}>
        {label && <h4 style={{ margin: '0 0 12px 0', color: 'var(--text-primary)', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '8px' }}>{label}</h4>}
        {payload.map((entry, index) => (
          <p key={index} style={{ margin: '6px 0', color: entry.color, display: 'flex', justifyContent: 'space-between', gap: '30px', fontSize: '14px', fontWeight: '500' }}>
            <span>{entry.name}:</span>
            <strong>{entry.value}</strong>
          </p>
        ))}
      </div>
    );
  }
  return null;
};

const getLastNDays = (n) => {
  return [...Array(n)].map((_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - i);
    return d.toISOString().split('T')[0];
  }).reverse();
};

const getDayLabel = (dateStr) => {
  const d = new Date(dateStr);
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  if (dateStr === today) return "Today";
  if (dateStr === yesterday) return "Yesterday";
  return d.toLocaleDateString('en-US', { weekday: 'short' });
};

const safeGetItem = (key, fallback = '') => {
  try {
    return sessionStorage.getItem(key) || fallback;
  } catch (e) {
    console.warn(`sessionStorage not accessible for key: ${key}`, e);
    return fallback;
  }
};

const safeSetItem = (key, value) => {
  try {
    sessionStorage.setItem(key, value);
  } catch (e) {
    console.warn(`sessionStorage write failed for key: ${key}`, e);
  }
};

const safeRemoveItem = (key) => {
  try {
    sessionStorage.removeItem(key);
  } catch (e) {
    console.warn(`sessionStorage remove failed for key: ${key}`, e);
  }
};

const formatISTTimeAndPassed = (dateString) => {
  if (!dateString) return '';
  const date = new Date(dateString);
  
  const istFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
  const istString = istFormatter.format(date);

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  let passed = '';
  if (diffMins < 1) {
    passed = 'just now';
  } else if (diffMins < 60) {
    passed = `${diffMins} min${diffMins > 1 ? 's' : ''} ago`;
  } else if (diffHours < 24) {
    const minsLeft = diffMins % 60;
    passed = `${diffHours} hour${diffHours > 1 ? 's' : ''} ${minsLeft > 0 ? `${minsLeft} min${minsLeft > 1 ? 's' : ''} ` : ''}ago`;
  } else {
    passed = `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
  }

  return `${istString} IST (${passed})`;
};

const fetchVisitorLogsHelper = async (client) => {
  try {
    const apiRes = await fetch('/api/visitors');
    if (apiRes.ok) {
      const json = await apiRes.json();
      if (Array.isArray(json.data)) {
        return { data: json.data, error: null };
      }
    }
  } catch (e) {
    console.warn('[VisitorFetch] API /api/visitors unavailable:', e);
  }

  if (!client) return { data: [], error: 'Supabase client not initialized' };

  try {
    const res1 = await client.from('visitors').select('*').order('id', { ascending: false }).limit(150);
    if (!res1.error && Array.isArray(res1.data)) return { data: res1.data, error: null };
  } catch (err) {
    return { data: [], error: err.message };
  }

  return { data: [], error: 'Could not query visitors table' };
};

function App() {
  const [activeTab, setActiveTab] = useState('SUMMARY'); 
  
  const [results, setResults] = useState([]);
  const [repoGroups, setRepoGroups] = useState({});
  const [repoChartData, setRepoChartData] = useState([]);
  const [globalTimeData, setGlobalTimeData] = useState([]);
  const [pieData, setPieData] = useState([]);
  const [tokenData, setTokenData] = useState([]);
  const [latencyData, setLatencyData] = useState([]);
  
  const [budgetUsed, setBudgetUsed] = useState(null);
  const [projectedUsage, setProjectedUsage] = useState(0);
  const [killSwitchActive, setKillSwitchActive] = useState(false);
  const [lowPowerMode, setLowPowerMode] = useState(false);
  
  const [userNotes, setUserNotes] = useState('');
  const [runsPerDay, setRunsPerDay] = useState(4);
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedCommit, setSelectedCommit] = useState(null);
  const [selectedRepo, setSelectedRepo] = useState(null);

  const [availableRepos, setAvailableRepos] = useState([]);
  const [activeRepos, setActiveRepos] = useState([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [newRepoUrl, setNewRepoUrl] = useState('');
  
  const [systemLogs, setSystemLogs] = useState([]);

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    setSelectedRepo(null);
    setSelectedCommit(null);
  };

  const toggleSwitch = async (key, currentVal, setter) => {
     const newVal = !currentVal;
     setter(newVal);
     try {
       const res = await fetch('/api/save-config', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ key, value: newVal ? 'true' : 'false' })
       });
       if (!res.ok) {
         const data = await res.json().catch(() => ({}));
         throw new Error(data.error || 'Failed to save configuration');
       }
     } catch (e) {
       console.error(`Failed to sync ${key}.`, e);
       alert(`Failed to save setting: ${e.message}`);
       setter(currentVal);
     }
  };

  const toggleRepo = async (repoUrl) => {
    const newRepos = activeRepos.includes(repoUrl) ? activeRepos.filter(r => r !== repoUrl) : [...activeRepos, repoUrl];
    setActiveRepos(newRepos);
    try {
      const res = await fetch('/api/save-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'REPOSITORIES', value: JSON.stringify(newRepos) })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save configuration');
      }
    } catch (e) {
      console.error('Failed to save config', e);
      alert(`Failed to save configuration: ${e.message}`);
      setActiveRepos(activeRepos);
    }
  };

  const handleManualRun = async () => {
    try {
      const res = await fetch('/api/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'HTTP ' + res.status);
      }
      alert('Automation triggered successfully! The explicit run will start shortly and sync telemetry.');
    } catch (e) {
      console.error(e);
      alert('Failed to trigger automation: ' + e.message);
    }
  };

  const updateRunsPerDay = async (numRuns) => {
    try {
      const res = await fetch('/api/update-schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ numRuns })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update schedule');
      }
      setRunsPerDay(numRuns);
      await fetch('/api/save-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'RUNS_PER_DAY', value: numRuns.toString() })
      });
      alert(`Successfully updated schedule to ${numRuns} runs per day!`);
    } catch (e) {
      console.error(e);
      alert('Error updating schedule: ' + e.message);
    }
  };

  const saveNotes = async () => {
    try {
      const res = await fetch('/api/save-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'USER_NOTES', value: userNotes })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save notes');
      }
      alert('Notes saved successfully.');
    } catch (e) {
      console.error('Failed to save notes.', e);
      alert('Failed to save notes: ' + e.message);
    }
  };

  useEffect(() => {
    async function fetchData() {
      if (!supabase) {
        setError('Supabase credentials missing.');
        setLoading(false);
        return;
      }
      
      try {
        const [repoRes, runsRes, configRes, runLogsRes] = await Promise.all([
          supabase.from('repo_results').select('*').order('processed_at', { ascending: false }).limit(500),
          supabase.from('runs').select('*').order('started_at', { ascending: false }).limit(100),
          supabase.from('system_config').select('*'),
          supabase.from('run_logs').select('*').in('level', ['error', 'warning']).order('ts', { ascending: false }).limit(50)
        ]);

        if (repoRes.error) throw repoRes.error;
        if (runsRes.error) throw runsRes.error;
        
        setSystemLogs(runLogsRes.data || []);

        let fetchedMinutes = 0;
        let dbRepos = [];

        configRes.data?.forEach(c => {
          if (c.key === 'DISABLE_BOT') setKillSwitchActive(c.value === 'true');
          if (c.key === 'MAINTENANCE_MODE') setLowPowerMode(c.value === 'true');
          if (c.key === 'GITHUB_ACTIONS_MINUTES') fetchedMinutes = !isNaN(parseInt(c.value)) ? parseInt(c.value) : fetchedMinutes;
          if (c.key === 'RUNS_PER_DAY') setRunsPerDay(parseInt(c.value) || 4);
          if (c.key === 'USER_NOTES') setUserNotes(c.value);
          if (c.key === 'REPOSITORIES') {
            try { dbRepos = JSON.parse(c.value) || []; } catch(e) { dbRepos = []; }
          }
        });

        let ghData = [];
        try {
          const token = import.meta.env.VITE_GITHUB_TOKEN;
          const targetUser = import.meta.env.VITE_GITHUB_USERNAME || 'owner';
          const ghRes = await fetch(`https://api.github.com/users/${targetUser}/repos?per_page=100&sort=updated`, {
            headers: token ? { 'Authorization': `Bearer ${token}` } : {}
          });
          if (ghRes.ok) ghData = await ghRes.json();
        } catch(e) {
          console.warn("GitHub fetch failed, falling back to DB repos", e);
        }

        const currentGithubUrls = Array.isArray(ghData) ? ghData.map(r => r.html_url) : [];
        if (currentGithubUrls.length > 0) setAvailableRepos(currentGithubUrls);
        setActiveRepos(dbRepos);

        const validNames = Array.isArray(dbRepos) ? dbRepos.map(url => {
          try { return url.split('/').pop(); } catch(e) { return url; }
        }) : [];
        const allResults = (repoRes.data || []).filter(r => validNames.length === 0 || validNames.includes(r.repo_name));
        const runs = runsRes.data || [];
        
        setBudgetUsed(fetchedMinutes);
        const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
        const currentDay = Math.max(1, new Date().getDate());
        setProjectedUsage(fetchedMinutes !== null ? Math.round((fetchedMinutes / currentDay) * daysInMonth) : 0); 

        const improved = allResults.filter(r => r.status === 'improved' || r.status === 'success');
        const uniqueResults = improved.filter((v, i, a) => v.pr_url && a.findIndex(t => t.pr_url === v.pr_url) === i);
        setResults(uniqueResults);

        const groups = {};
        uniqueResults.forEach(r => {
          if (!groups[r.repo_name]) groups[r.repo_name] = [];
          groups[r.repo_name].push(r);
        });
        setRepoGroups(groups);

        const last5Days = getLastNDays(5);
        const repoStats = {};
        const globalStats = {};
        const dailyTokens = {};
        last5Days.forEach(d => { globalStats[d] = 0; dailyTokens[d] = 0; });

        uniqueResults.forEach(r => {
          const repoName = r.repo_name;
          if (!repoStats[repoName]) {
            repoStats[repoName] = { name: repoName, days: {} };
            last5Days.forEach(d => repoStats[repoName].days[d] = 0);
          }
          if (!r.processed_at) return;
          const dt = new Date(r.processed_at);
          if (isNaN(dt.getTime())) return;
          const processDate = dt.toISOString().split('T')[0];
          let changedFilesCount = Array.isArray(r.files_changed) ? r.files_changed.length : (r.files_changed ? 1 : 1);
          if (globalStats[processDate] !== undefined) {
            repoStats[repoName].days[processDate] += 1;
            globalStats[processDate] += 1;
            dailyTokens[processDate] += (changedFilesCount * 2850);
          }
        });
        
        setGlobalTimeData(last5Days.map(d => ({ date: d, 'Total System Commits': globalStats[d] })));
        setTokenData(last5Days.map(d => ({ date: d, 'Est. Tokens Consumed': dailyTokens[d] })));
        setRepoChartData(Object.values(repoStats).map(repo => ({
          name: repo.name,
          data: last5Days.map(d => ({ date: d, 'Repository Commits': repo.days[d] }))
        })));

        const statusCounts = { success: 0, failed: 0, partial: 0, skipped: 0 };
        allResults.forEach(r => {
          const st = r.status?.toLowerCase() || '';
          if (st === 'improved' || st === 'success') statusCounts.success++;
          else if (st === 'error' || st === 'failed') statusCounts.failed++;
          else if (st === 'partial') statusCounts.partial++;
          else st === 'skipped' ? statusCounts.skipped++ : statusCounts.skipped++;
        });
        
        const pie = [];
        if (statusCounts.success > 0) pie.push({ name: 'Success', value: statusCounts.success, color: '#22c55e' });
        if (statusCounts.failed > 0) pie.push({ name: 'Failed', value: statusCounts.failed, color: '#ef4444' });
        if (statusCounts.partial > 0) pie.push({ name: 'Partial', value: statusCounts.partial, color: '#eab308' });
        if (statusCounts.skipped > 0) pie.push({ name: 'Skipped', value: statusCounts.skipped, color: '#64748b' });
        setPieData(pie);

        const latencies = runs
          .filter(r => r.finished_at && r.started_at && r.status !== 'running')
          .map(r => ({
            runId: r.id.substring(0,6),
            date: new Date(r.started_at).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}),
            'Latency (sec)': Math.max(1, Math.round((new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()) / 1000))
          })).slice(0, 15).reverse();
        setLatencyData(latencies);

      } catch (err) {
        console.error(err);
        setError(`Failed to fetch data: ${err.message || err}`);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, []);

  return (
    <div className="app-container">
      <header className="header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '40px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ background: 'var(--accent-glow)', padding: '12px', borderRadius: '50%', boxShadow: '0 0 20px var(--accent-glow)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Radar size={32} color="var(--accent-light)" className="radar-spin" />
          </div>
          <div>
            <h1 style={{ margin: 0, textShadow: '0 0 10px rgba(168, 85, 247, 0.5)' }}>RepoSonar</h1>
            <p style={{ margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)' }}>
               <Activity size={14} color="var(--accent-primary)"/> Autonomous AI Telemetry Engine
            </p>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '16px' }}>
          <button 
            onClick={handleManualRun}
            style={{ 
              padding: '10px 20px', borderRadius: '14px', border: 'none', cursor: 'pointer',
              background: 'linear-gradient(135deg, #38bdf8 0%, #0284c7 100%)',
              color: 'white', display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'bold',
              boxShadow: '0 0 15px rgba(56, 189, 248, 0.4)'
            }}
          >
            <Zap size={16} /> RUN
          </button>
          <button 
            onClick={() => toggleSwitch('MAINTENANCE_MODE', lowPowerMode, setLowPowerMode)}
            style={{ 
              padding: '10px 20px', borderRadius: '14px', border: '1px solid var(--panel-border)', cursor: 'pointer',
              background: lowPowerMode ? 'rgba(56, 189, 248, 0.1)' : 'transparent',
              color: lowPowerMode ? '#38bdf8' : 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'bold', transition: 'all 0.3s'
            }}
          >
            <ShieldAlert size={16} /> LOW-POWER: {lowPowerMode ? 'ON' : 'OFF'}
          </button>
          <button 
            onClick={() => toggleSwitch('DISABLE_BOT', killSwitchActive, setKillSwitchActive)}
            style={{ 
              padding: '10px 20px', borderRadius: '14px', border: 'none', cursor: 'pointer',
              background: killSwitchActive ? 'var(--danger)' : 'rgba(255,255,255,0.05)',
              color: 'white', display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'bold',
              boxShadow: killSwitchActive ? '0 0 15px rgba(239, 68, 68, 0.4)' : 'none'
            }}
          >
            <Power size={16} /> {killSwitchActive ? 'LOCKED' : 'KILL'}
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '8px' }}>
            <span style={{ color: 'var(--text-secondary)', fontSize: '14px', fontWeight: 'bold' }}>Runs/Day:</span>
            {[1, 2, 3, 4].map(num => (
              <button 
                key={num}
                onClick={() => updateRunsPerDay(num)}
                style={{
                  padding: '6px 10px', borderRadius: '8px', border: runsPerDay === num ? '1px solid var(--accent-primary)' : '1px solid var(--panel-border)', cursor: 'pointer',
                  background: runsPerDay === num ? 'rgba(168, 85, 247, 0.2)' : 'rgba(255,255,255,0.05)',
                  color: runsPerDay === num ? 'white' : 'var(--text-secondary)', fontWeight: 'bold'
                }}
              >
                {num}
              </button>
            ))}
          </div>
        </div>
      </header>
      
      <div className="nav-bar">
        <button className={`nav-tab ${activeTab === 'SUMMARY' ? 'active' : ''}`} onClick={() => handleTabChange('SUMMARY')}><FileText size={18} /> SUMMARY</button>
        <button className={`nav-tab ${activeTab === 'GRAPHS' ? 'active' : ''}`} onClick={() => handleTabChange('GRAPHS')}><BarChart2 size={18} /> GRAPHS & METRICS</button>
        <button className={`nav-tab ${activeTab === 'DETAILS' ? 'active' : ''}`} onClick={() => handleTabChange('DETAILS')}><GitBranch size={18} /> COMMIT DETAILS</button>
        <button className={`nav-tab ${activeTab === 'REPOSITORIES' ? 'active' : ''}`} onClick={() => handleTabChange('REPOSITORIES')}><LayoutGrid size={18} /> REPOSITORIES</button>
        <button className={`nav-tab ${activeTab === 'FAULTS' ? 'active' : ''}`} onClick={() => handleTabChange('FAULTS')}><AlertCircle size={18} /> FAULTS</button>
        <button className={`nav-tab ${activeTab === 'NOTES' ? 'active' : ''}`} onClick={() => handleTabChange('NOTES')}><FileText size={18} /> NOTES</button>
      </div>

      {loading ? <div className="spinner"></div> : error ? <div className="glass-panel" style={{ padding: '24px', textAlign: 'center' }}><AlertCircle size={48} color="var(--danger)" /><p>{error}</p></div> : (
        <>
          {activeTab === 'SUMMARY' && (
            <div>
              <div className="glass-panel" style={{ padding: '20px 24px', marginBottom: '24px', borderLeft: '4px solid var(--accent-primary)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                  <Zap size={20} color="var(--accent-light)" />
                  <h3 style={{ margin: 0, fontSize: '16px', color: 'white' }}>Feature & Workflow Notes — Summary Overview</h3>
                </div>
                <p style={{ margin: 0, fontSize: '14px', color: 'var(--text-secondary)', lineHeight: '1.6' }}>
                  <strong>Purpose:</strong> Displays real-time status matrix, log counts, 7-day contribution heatmaps, and last activity timestamps for all connected repositories.<br/>
                  <strong>Project Working:</strong> RepoSonar runs an automated workflow (via GitHub Actions & Python orchestrator) that pulls target repos, scans source code for undocumented features, uses multi-provider AI (Groq, GitHub Models, OpenRouter, Gemini) to update README documentation, and logs commit metrics directly to Supabase.
                </p>
              </div>
              <div className="repos-grid">
              {Object.keys(repoGroups).map((repoName) => {
                const repoCommits = repoGroups[repoName];
                const heatmapDays = getLastNDays(7);
                const lastCommit = repoCommits[0];
                const lastCommitText = lastCommit ? formatISTTimeAndPassed(lastCommit.processed_at) : 'No activity';
                return (
                  <div key={repoName} className="glass-card repo-card" onClick={() => {setSelectedRepo(repoName); setActiveTab('DETAILS'); setSelectedCommit(null);}} style={{ padding: '24px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                    <div>
                      <div className="repo-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <h3 className="repo-title" style={{ margin: 0, fontSize: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}><LayoutGrid size={20} color="var(--accent-light)" /> {repoName}</h3>
                        <span className="badge purple">{repoCommits.length} Logs</span>
                      </div>
                      <div style={{ marginTop: '20px' }}>
                        <p style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '1px' }}>7-Day Contribution Matrix</p>
                        <div style={{ display: 'flex', gap: '4px' }}>
                          {heatmapDays.map(date => {
                            const hasCommit = repoCommits.some(c => new Date(c.processed_at).toISOString().split('T')[0] === date);
                            return <div key={date} title={date} style={{ flex: 1, height: '24px', borderRadius: '4px', background: hasCommit ? 'linear-gradient(135deg, #a855f7, #6366f1)' : 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)' }}></div>;
                          })}
                        </div>
                      </div>
                    </div>
                    <div style={{ marginTop: '20px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <Clock size={14} color="var(--text-secondary)" />
                      <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                        Last Activity: <span style={{ color: 'var(--text-primary)', fontWeight: '500' }}>{lastCommitText}</span>
                      </span>
                    </div>
                  </div>
                );
              })}
              </div>
            </div>
          )}

          {activeTab === 'GRAPHS' && (
            <div style={{ animation: 'slideUp 0.5s ease-out' }}>
              <div className="glass-panel" style={{ padding: '20px 24px', marginBottom: '24px', borderLeft: '4px solid #38bdf8' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                  <BarChart2 size={20} color="#38bdf8" />
                  <h3 style={{ margin: 0, fontSize: '16px', color: 'white' }}>Feature & Workflow Notes — Telemetry & Analytics</h3>
                </div>
                <p style={{ margin: 0, fontSize: '14px', color: 'var(--text-secondary)', lineHeight: '1.6' }}>
                  <strong>Purpose:</strong> Provides interactive charts tracking AI Token Consumption, Runner Latency, 5-Day System Commits, Workflow Stability, and Repo Refinement Pulses.<br/>
                  <strong>Project Working:</strong> Analyzes execution telemetry in real-time to monitor token usage trends, optimize API cost guardrails, prevent rate limits via SHA-256 hash caching (<code>SmartOptimizer</code>), and verify run stability.
                </p>
              </div>

              <div style={{ display: 'flex', gap: '24px', marginBottom: '32px', flexWrap: 'wrap' }}>
                <div className="glass-card" style={{ flex: '2 1 500px', padding: '32px' }}>
                  <h3 style={{ margin: '0 0 20px 0', fontSize: '18px', display: 'flex', alignItems: 'center', gap: '10px' }}><Cpu size={22} color="#38bdf8"/> Gemini Token AI Usage</h3>
                  <div style={{ height: '220px' }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={tokenData}><defs><linearGradient id="colorToken" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#38bdf8" stopOpacity={0.6}/><stop offset="95%" stopColor="#0284c7" stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} /><XAxis dataKey="date" stroke="var(--text-secondary)" tick={{fontSize: 11}} /><YAxis stroke="var(--text-secondary)" /><Tooltip content={<CustomTooltip />} /><Area type="monotone" dataKey="Est. Tokens Consumed" stroke="#38bdf8" strokeWidth={3} fill="url(#colorToken)" /></AreaChart>
                    </ResponsiveContainer>
                  </div>
                </div>
                <div className="glass-card" style={{ flex: '1 1 300px', padding: '32px' }}><h3 style={{ margin: '0 0 20px 0', fontSize: '18px' }}><Zap size={22} color="#f59e0b"/> Runner Latency Pulse</h3>
                  <div style={{ height: '220px' }}><ResponsiveContainer width="100%" height="100%"><BarChart data={latencyData}><CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.02)" vertical={false} /><XAxis dataKey="date" stroke="var(--text-secondary)" tick={{fontSize: 10}} /><YAxis stroke="var(--text-secondary)" /><Tooltip content={<CustomTooltip />} /><Bar dataKey="Latency (sec)" fill="#f59e0b" radius={[4, 4, 0, 0]} /></BarChart></ResponsiveContainer></div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '24px', marginBottom: '32px', flexWrap: 'wrap' }}>
                <div className="glass-panel" style={{ flex: '2 1 500px', padding: '32px' }}><h2 style={{ margin: '0 0 20px 0', fontSize: '20px' }}><Activity size={24} color="var(--accent-primary)"/> Global 5-Day Commit Telemetry</h2>
                  <div style={{ height: '250px' }}><ResponsiveContainer width="100%" height="100%"><AreaChart data={globalTimeData}><defs><linearGradient id="colorGlobal" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#c084fc" stopOpacity={0.6}/><stop offset="95%" stopColor="#9333ea" stopOpacity={0}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} /><XAxis dataKey="date" stroke="var(--text-secondary)" /><YAxis stroke="var(--text-secondary)" /><Tooltip content={<CustomTooltip />} /><Area type="monotone" dataKey="Total System Commits" stroke="#c084fc" strokeWidth={3} fill="url(#colorGlobal)" /></AreaChart></ResponsiveContainer></div>
                </div>
                <div className="glass-panel" style={{ flex: '1 1 300px', padding: '32px' }}><h2 style={{ margin: '0 0 20px 0', fontSize: '20px' }}><ShieldAlert size={24} color="#10b981"/> Workflow Stability Ring</h2>
                  <div style={{ height: '220px', width: '100%' }}><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={pieData} cx="50%" cy="50%" innerRadius={60} outerRadius={85} paddingAngle={3} dataKey="value" stroke="none">{pieData.map((entry, index) => <Cell key={`cell-${index}`} fill={entry.color} />)}</Pie><Tooltip content={<CustomTooltip />} /></PieChart></ResponsiveContainer></div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'center' }}>{pieData.map(entry => <span key={entry.name} style={{ fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--text-secondary)' }}><span style={{ width: '8px', height: '8px', borderRadius: '50%', background: entry.color }}></span>{entry.name}</span>)}</div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
                {repoChartData.map((repo, idx) => (
                  <div key={idx} className="glass-card" style={{ flex: '1 1 450px', padding: '32px' }}>
                    <h3 style={{ margin: '0 0 24px 0', fontSize: '18px' }}>{repo.name} Refinement Pulse</h3>
                    <div style={{ height: '220px' }}>
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={repo.data}><CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} /><XAxis dataKey="date" stroke="var(--text-secondary)" tick={{fontSize: 11}} /><YAxis stroke="var(--text-secondary)" width={30} /><Tooltip content={<CustomTooltip />} /><Line type="monotone" dataKey="Repository Commits" stroke="#a855f7" strokeWidth={4} dot={{ r: 6, fill: '#a855f7' }} /></LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'DETAILS' && (
            <div style={{ animation: 'slideUp 0.5s ease-out' }}>
              <div className="glass-panel" style={{ padding: '20px 24px', marginBottom: '24px', borderLeft: '4px solid #a855f7' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                  <GitBranch size={20} color="#a855f7" />
                  <h3 style={{ margin: 0, fontSize: '16px', color: 'white' }}>Feature & Workflow Notes — Commit Log & Diff Inspection</h3>
                </div>
                <p style={{ margin: 0, fontSize: '14px', color: 'var(--text-secondary)', lineHeight: '1.6' }}>
                  <strong>Purpose:</strong> Allows developers to inspect individual documentation commits and view GitHub diff comparisons.<br/>
                  <strong>Project Working:</strong> When documentation improvements are committed directly or via pull requests, commit details and PR URLs are stored in Supabase <code>repo_results</code>. The interactive <code>DiffViewer</code> component parses original vs. improved markdown to highlight exact changes.
                </p>
              </div>

               {!selectedRepo ? (
                 <div className="repos-grid">
                    {Object.keys(repoGroups).map(repoName => (
                       <div key={repoName} className="glass-card repo-card" onClick={() => setSelectedRepo(repoName)}>
                         <h3 className="repo-title"><GitBranch size={20} color="var(--accent-light)" /> {repoName}</h3>
                         <p style={{ marginTop: '10px', fontSize: '14px', color: 'var(--text-secondary)' }}>Click to view logs</p>
                       </div>
                    ))}
                 </div>
               ) : !selectedCommit ? (
                 <>
                   <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}><button onClick={() => setSelectedRepo(null)} className="btn primary">Back</button><h2 style={{ fontSize: '22px' }}>Logs: {selectedRepo}</h2></div>
                   <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                      {results.filter(c => c.repo_name === selectedRepo).slice(0, 30).map(commit => (
                        <div key={commit.id} className="glass-card commit-row" onClick={() => setSelectedCommit(commit)} style={{ padding: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                            <Clock size={20} color="var(--text-secondary)" />
                            <div><h4 style={{ margin: 0 }}>{commit.commit_message || "docs: update"}</h4><p style={{ margin: '4px 0 0', fontSize: '13px', color: 'var(--text-secondary)' }}>{formatISTTimeAndPassed(commit.processed_at)}</p></div>
                          </div>
                          <span style={{ fontSize: '12px', padding: '4px 10px', borderRadius: '6px', background: 'rgba(34, 197, 94, 0.1)', color: '#22c55e', border: '1px solid rgba(34, 197, 94, 0.2)' }}>Refinement Signal</span>
                        </div>
                      ))}
                   </div>
                 </>
               ) : (
                 <div className="glass-panel diff-container">
                    <div className="diff-header" style={{ display: 'flex', justifyContent: 'space-between' }}><button onClick={() => setSelectedCommit(null)} className="btn primary">Back</button><a href={selectedCommit.pr_url} target="_blank" rel="noreferrer" className="btn primary">View on GitHub</a></div>
                    <DiffViewer commitUrl={selectedCommit.pr_url} />
                 </div>
               )}
            </div>
          )}

          {activeTab === 'REPOSITORIES' && (
            <div style={{ animation: 'slideUp 0.5s ease-out' }}>
              <div className="glass-panel" style={{ padding: '20px 24px', marginBottom: '24px', borderLeft: '4px solid #10b981' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                  <LayoutGrid size={20} color="#10b981" />
                  <h3 style={{ margin: 0, fontSize: '16px', color: 'white' }}>Feature & Workflow Notes — Repository Sync Configuration</h3>
                </div>
                <p style={{ margin: 0, fontSize: '14px', color: 'var(--text-secondary)', lineHeight: '1.6' }}>
                  <strong>Purpose:</strong> Control panel for connecting or disconnecting target GitHub repositories for automated AI monitoring.<br/>
                  <strong>Project Working:</strong> Connected repositories are saved in Supabase <code>system_config</code>. On scheduled cron runs, the Python orchestrator loads this configuration to clone, analyze, and refine READMEs for all connected projects.
                </p>
              </div>

              <div className="glass-panel" style={{ padding: '32px', marginBottom: '32px' }}>
                <h2 style={{ fontSize: '20px', display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
                  <LayoutGrid size={24} color="var(--accent-primary)"/> Repository Sync Configuration
                </h2>
                <p style={{ color: 'var(--text-secondary)', marginBottom: '24px' }}>
                  Select which repositories the AI should analyze and improve automatically.
                </p>
                
                {reposLoading ? <div className="spinner"></div> : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '500px', overflowY: 'auto', paddingRight: '8px' }} className="custom-scrollbar">
                    {availableRepos.map(repo => {
                      const isActive = activeRepos.includes(repo);
                      return (
                        <div key={repo} className="glass-card" style={{ padding: '16px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: isActive ? '1px solid var(--accent-primary)' : '1px solid rgba(255,255,255,0.05)', background: isActive ? 'rgba(6, 182, 212, 0.05)' : 'rgba(255,255,255,0.02)' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                            <GitBranch size={18} color={isActive ? "var(--accent-primary)" : "var(--text-secondary)"} />
                            <span style={{ fontSize: '15px', color: isActive ? 'white' : 'var(--text-secondary)' }}>{repo.split('/').pop()}</span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                            <span className="badge success">Auto-Synced</span>
                            <button onClick={() => toggleRepo(repo)} style={{ padding: '8px 16px', borderRadius: '8px', border: 'none', cursor: 'pointer', background: isActive ? 'var(--danger)' : 'var(--accent-primary)', color: 'white', fontWeight: 'bold' }}>
                              {isActive ? 'Disconnect' : 'Connect'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'FAULTS' && (
            <div style={{ animation: 'slideUp 0.5s ease-out' }}>
              <div className="glass-panel" style={{ padding: '20px 24px', marginBottom: '24px', borderLeft: '4px solid var(--danger)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                  <AlertCircle size={20} color="var(--danger)" />
                  <h3 style={{ margin: 0, fontSize: '16px', color: 'white' }}>Feature & Workflow Notes — System Fault Diagnostics</h3>
                </div>
                <p style={{ margin: 0, fontSize: '14px', color: 'var(--text-secondary)', lineHeight: '1.6' }}>
                  <strong>Purpose:</strong> Surfaces real-time operational warnings, API error stack traces, rate-limit warnings, and repository refinement failures.<br/>
                  <strong>Project Working:</strong> <code>SupabaseLogger</code> buffers log events and records warnings/errors into <code>run_logs</code> and <code>repo_results</code>. If critical errors or quota limits occur, Discord webhooks send immediate alerts to operators.
                </p>
              </div>

              <div className="glass-panel" style={{ padding: '32px' }}>
                <h2 style={{ fontSize: '20px', display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
                  <AlertCircle size={24} color="var(--danger)"/> System Faults & Errors
                </h2>
                
                <h3 style={{ fontSize: '16px', margin: '20px 0 10px 0', color: 'var(--text-primary)' }}>System Logs (Telemetry & API)</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '32px' }}>
                  {systemLogs.length === 0 ? (
                    <p style={{ color: 'var(--text-secondary)' }}>No system warnings recorded recently.</p>
                  ) : (
                    systemLogs.map((log, idx) => (
                      <div key={'sys-'+idx} className="glass-card" style={{ padding: '20px', borderLeft: log.level === 'error' ? '4px solid var(--danger)' : '4px solid #f59e0b' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                          <strong style={{ color: log.level === 'error' ? 'var(--danger)' : '#f59e0b', textTransform: 'uppercase' }}>{log.level}</strong>
                          <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>{new Date(log.ts).toLocaleString()}</span>
                        </div>
                        <p style={{ margin: 0, fontSize: '14px', fontFamily: 'monospace' }}>
                          {log.message}
                        </p>
                      </div>
                    ))
                  )}
                </div>

                <h3 style={{ fontSize: '16px', margin: '20px 0 10px 0', color: 'var(--text-primary)' }}>Repository Refinement Failures</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {results.filter(r => r.status === 'error' || r.status === 'failed').length === 0 ? (
                    <p style={{ color: 'var(--text-secondary)' }}>No repository faults recorded recently.</p>
                  ) : (
                    results.filter(r => r.status === 'error' || r.status === 'failed').map((fault, idx) => (
                      <div key={idx} className="glass-card" style={{ padding: '20px', borderLeft: '4px solid var(--danger)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                          <strong>{fault.repo_name}</strong>
                          <span style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>{new Date(fault.processed_at).toLocaleString()}</span>
                        </div>
                        <p style={{ color: 'var(--danger)', margin: 0, fontSize: '14px', fontFamily: 'monospace' }}>
                          {fault.error || fault.commit_message || "Unknown error"}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'NOTES' && (
            <div style={{ animation: 'slideUp 0.5s ease-out' }}>
              <div className="glass-panel" style={{ padding: '20px 24px', marginBottom: '24px', borderLeft: '4px solid #f59e0b' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                  <FileText size={20} color="#f59e0b" />
                  <h3 style={{ margin: 0, fontSize: '16px', color: 'white' }}>Feature & Workflow Notes — Architectural Remarks & Directives</h3>
                </div>
                <p style={{ margin: 0, fontSize: '14px', color: 'var(--text-secondary)', lineHeight: '1.6' }}>
                  <strong>Purpose:</strong> Persistent system notepad for team notes, workflow directives, and prompt guidance.<br/>
                  <strong>Project Working:</strong> Text entered here is synced to Supabase <code>system_config</code> under the key <code>USER_NOTES</code>. This allows developers to leave persistent context or instructions for automated documentation maintenance across runs.
                </p>
              </div>

              <div className="glass-panel" style={{ padding: '32px' }}>
                <h2 style={{ fontSize: '20px', display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
                  <FileText size={24} color="var(--accent-primary)"/> System Notes & Architectural Remarks
                </h2>
                <textarea 
                  value={userNotes}
                  onChange={(e) => setUserNotes(e.target.value)}
                  placeholder="Type notes or workflow directives here..."
                  style={{ width: '100%', height: '300px', padding: '16px', borderRadius: '12px', background: 'rgba(0,0,0,0.3)', color: 'white', border: '1px solid var(--panel-border)', fontSize: '15px', resize: 'vertical' }}
                />
                <button 
                  onClick={saveNotes}
                  style={{ marginTop: '16px', padding: '10px 20px', borderRadius: '12px', background: 'var(--accent-primary)', color: 'white', fontWeight: 'bold', border: 'none', cursor: 'pointer' }}
                >
                  Save Notes
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default App;
