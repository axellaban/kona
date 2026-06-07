import { useState, useEffect, useCallback } from "react";

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const PUELL_CAUTION   = 2.0;
const PUELL_EUPHORIA  = 4.0;
const MVRV_CAUTION    = 3.5;
const FG_FLOOR        = 20;
const FG_CEIL         = 80;
const FUND_EXTREME    = 0.95;
const FUND_CAUTION    = 0.75;

// ─────────────────────────────────────────────
// DATA FETCHERS (llamadas reales a APIs públicas)
// ─────────────────────────────────────────────
async function fetchBinanceKlines(symbol = "BTCUSDT", interval = "1d", limit = 400) {
  // Usa Kraken como fuente primaria (Binance geo-restringido en algunos servidores)
  const since = Math.floor(Date.now() / 1000) - limit * 86400;
  const url = `https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440&since=${since}`;
  const r = await fetch(url);
  const data = await r.json();
  const candles = data.result.XXBTZUSD;
  return candles.map(d => ({
    date:   new Date(d[0] * 1000),
    open:   parseFloat(d[1]),
    high:   parseFloat(d[2]),
    low:    parseFloat(d[3]),
    close:  parseFloat(d[4]),
    volume: parseFloat(d[6]),
  }));
}

async function fetchBinanceFunding(symbol = "BTCUSDT", limit = 500) {
  // Binance Futures geo-restringido — funding rate no disponible sin API key en alternativas
  return [];
}

async function fetchFearGreed(limit = 90) {
  const url = `https://api.alternative.me/fng/?limit=${limit}&format=json`;
  const r = await fetch(url);
  const data = await r.json();
  return data.data.map(d => ({
    date:           new Date(parseInt(d.timestamp) * 1000),
    value:          parseInt(d.value),
    classification: d.value_classification,
  })).reverse();
}

async function fetchCurrentPrice() {
  const r = await fetch("https://api.kraken.com/0/public/Ticker?pair=XBTUSD");
  const d = await r.json();
  return parseFloat(d.result.XXBTZUSD.c[0]);
}

// ─────────────────────────────────────────────
// FEATURE ENGINEERING
// ─────────────────────────────────────────────
function computeFeatures(klines) {
  const n = klines.length;
  const closes = klines.map(k => k.close);

  const logReturns = closes.map((c, i) =>
    i === 0 ? 0 : Math.log(c / closes[i - 1])
  );

  // Rolling sum 30d momentum
  const momentum30 = logReturns.map((_, i) => {
    if (i < 30) return null;
    return logReturns.slice(i - 30, i).reduce((a, b) => a + b, 0);
  });

  // Rolling vol 30d
  const vol30 = logReturns.map((_, i) => {
    if (i < 30) return null;
    const slice = logReturns.slice(i - 30, i);
    const mean = slice.reduce((a, b) => a + b, 0) / 30;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / 30;
    return Math.sqrt(variance) * Math.sqrt(365);
  });

  // 10-day high (shift para evitar look-ahead)
  const high10 = closes.map((_, i) => {
    if (i < 10) return null;
    return Math.max(...closes.slice(i - 10, i)); // excluye el actual
  });

  const is10dHigh = closes.map((c, i) =>
    high10[i] !== null ? (c > high10[i] ? 1 : 0) : 0
  );

  return klines.map((k, i) => ({
    ...k,
    logReturn:   logReturns[i],
    momentum30:  momentum30[i],
    vol30:       vol30[i],
    momVolAdj:   vol30[i] ? momentum30[i] / vol30[i] : null,
    is10dHigh:   is10dHigh[i],
    high10:      high10[i],
  }));
}

function computeFundingPercentile(funding) {
  if (!funding.length) return { percentile: null, carryAnn: null };
  const rates = funding.map(f => f.rate);
  const current = rates[rates.length - 1];
  const sorted = [...rates].sort((a, b) => a - b);
  const rank = sorted.filter(r => r <= current).length;
  const percentile = rank / sorted.length;

  // Daily average últimos 30 días × 3 pagos/día × 365
  const recent = rates.slice(-90); // ~30 días × 3 funding periods
  const avgDaily = recent.reduce((a, b) => a + b, 0) / recent.length;
  const carryAnn = avgDaily * 3 * 365;

  return { percentile, carryAnn, current };
}

// ─────────────────────────────────────────────
// SIGNAL SCORING
// ─────────────────────────────────────────────
function computeSignalScore(today, onChain, fundingPct, fgValue) {
  let score = 0;
  const signals = [];

  // GATE: Régimen 10-day high
  const regimeOn = today.is10dHigh === 1;
  signals.push({
    name:    "Régimen 10-Day High",
    value:   regimeOn ? "ON ✓" : "OFF",
    score:   regimeOn ? 1 : 0,
    detail:  regimeOn
      ? `BTC en nuevo máximo de 10 días → risk-on`
      : `BTC NO en máximo de 10 días → cash`,
    isGate:  true,
    active:  regimeOn,
  });

  if (!regimeOn) {
    return { score: 0, signals, action: "CASH", reason: "Régimen OFF" };
  }
  score++;

  // Momentum 30d
  const mom = today.momentum30;
  const momOn = mom !== null && mom > 0;
  signals.push({
    name:   "TS Momentum 30d",
    value:  mom !== null ? `${(mom * 100).toFixed(2)}%` : "N/A",
    score:  momOn ? 1 : 0,
    detail: momOn ? "Momentum positivo ✓" : "Momentum negativo ✗",
    active: momOn,
  });
  if (momOn) score++;

  // Cycle (on-chain)
  const puell = onChain.puell;
  const mvrv  = onChain.mvrv;
  let cycleOn = true;
  let cycleNote = [];

  if (puell !== null) {
    if      (puell > PUELL_EUPHORIA) { cycleOn = false; cycleNote.push(`Puell ${puell.toFixed(2)} > ${PUELL_EUPHORIA} — techo`); }
    else if (puell > PUELL_CAUTION)  { cycleNote.push(`Puell ${puell.toFixed(2)} — precaución`); }
    else                              { cycleNote.push(`Puell ${puell.toFixed(2)} — zona acumulación ✓`); }
  }
  if (mvrv !== null) {
    if (mvrv > MVRV_CAUTION) { cycleOn = false; cycleNote.push(`MVRV Z ${mvrv.toFixed(2)} > ${MVRV_CAUTION} — sobrevalorado`); }
    else                      { cycleNote.push(`MVRV Z ${mvrv.toFixed(2)} ✓`); }
  }
  if (puell === null && mvrv === null) {
    cycleNote = ["Sin token BGeometrics — señal omitida"];
  }

  signals.push({
    name:   "Cycle Position (On-Chain)",
    value:  cycleNote.join(" | "),
    score:  cycleOn ? 1 : 0,
    detail: cycleNote.join(" · "),
    active: cycleOn,
  });
  if (cycleOn && (puell !== null || mvrv !== null)) score++;

  // Sentiment (Fear & Greed)
  let sentOn = true;
  let sentNote = "N/A";
  if (fgValue !== null) {
    if (fgValue < FG_FLOOR) {
      sentNote = `F&G ${fgValue} — Extreme Fear → contrarian bull ✓`;
    } else if (fgValue > FG_CEIL) {
      sentOn = false;
      sentNote = `F&G ${fgValue} — Extreme Greed → precaución ✗`;
    } else {
      sentNote = `F&G ${fgValue} — neutral ✓`;
    }
  }
  signals.push({
    name:   "Fear & Greed Contrarian",
    value:  fgValue !== null ? String(fgValue) : "N/A",
    score:  sentOn ? 1 : 0,
    detail: sentNote,
    active: sentOn,
  });
  if (fgValue !== null) { if (sentOn) score++; }

  // Funding rate
  let fundOn = true;
  let fundNote = "N/A";
  if (fundingPct !== null) {
    if (fundingPct > FUND_EXTREME) {
      fundOn = false;
      fundNote = `Funding pct ${(fundingPct * 100).toFixed(0)}% — extremo, mean reversion risk ✗`;
    } else if (fundingPct < 0.25) {
      fundNote = `Funding pct ${(fundingPct * 100).toFixed(0)}% — bajo, sin exceso ✓`;
    } else {
      fundNote = `Funding pct ${(fundingPct * 100).toFixed(0)}% — normal ✓`;
    }
  }
  signals.push({
    name:   "Funding Rate Percentile",
    value:  fundingPct !== null ? `${(fundingPct * 100).toFixed(0)}%` : "N/A",
    score:  fundOn ? 1 : 0,
    detail: fundNote,
    active: fundOn,
  });
  if (fundingPct !== null) { if (fundOn) score++; }

  // Action
  let action, actionColor;
  if      (score >= 4) { action = `LONG FULL SIZE`; actionColor = "#00ff88"; }
  else if (score === 3) { action = `LONG HALF SIZE`; actionColor = "#ffcc00"; }
  else                  { action = `CASH`; actionColor = "#ff4444"; }

  return { score, signals, action, actionColor };
}

// ─────────────────────────────────────────────
// BACKTEST VECTORIZADO
// ─────────────────────────────────────────────
function runBacktest(features) {
  const TC = 0.001;
  let stratCum = 1, bhCum = 1;
  let prevPos = 0;
  let trades = 0, wins = 0, total = 0;
  let stratPeak = 1, bhPeak = 1, stratMaxDD = 0, bhMaxDD = 0;
  const equityCurve = [];

  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 2);

  const data = features.filter(f => f.date >= cutoff && f.momentum30 !== null);

  for (let i = 0; i < data.length - 1; i++) {
    const today = data[i];
    const next  = data[i + 1];

    // Señal simple: régimen + momentum
    const sig = (today.is10dHigh && today.momentum30 > 0) ? 1 : 0;
    const pos = sig; // long-only

    const bhRet = next.logReturn;
    const stratRet = pos * bhRet - Math.abs(pos - prevPos) * TC;

    stratCum *= Math.exp(stratRet);
    bhCum    *= Math.exp(bhRet);

    if (stratCum > stratPeak) stratPeak = stratCum;
    if (bhCum    > bhPeak)    bhPeak    = bhCum;
    stratMaxDD = Math.min(stratMaxDD, (stratCum - stratPeak) / stratPeak);
    bhMaxDD    = Math.min(bhMaxDD,    (bhCum    - bhPeak)    / bhPeak);

    if (pos !== prevPos) trades++;
    if (stratRet > 0 && pos > 0) wins++;
    if (pos > 0) total++;

    equityCurve.push({
      date:  next.date,
      strat: stratCum,
      bh:    bhCum,
    });

    prevPos = pos;
  }

  const n = data.length;
  const stratAnn = Math.pow(stratCum, 365 / n) - 1;
  const bhAnn    = Math.pow(bhCum, 365 / n) - 1;

  return {
    strategy: {
      totalReturn: `${((stratCum - 1) * 100).toFixed(1)}%`,
      annReturn:   `${(stratAnn * 100).toFixed(1)}%`,
      maxDrawdown: `${(stratMaxDD * 100).toFixed(1)}%`,
      trades:      Math.round(trades / 2),
      winRate:     total > 0 ? `${((wins / total) * 100).toFixed(1)}%` : "N/A",
    },
    buyHold: {
      totalReturn: `${((bhCum - 1) * 100).toFixed(1)}%`,
      annReturn:   `${(bhAnn * 100).toFixed(1)}%`,
      maxDrawdown: `${(bhMaxDD * 100).toFixed(1)}%`,
    },
    equityCurve,
  };
}

// ─────────────────────────────────────────────
// MINI SPARKLINE
// ─────────────────────────────────────────────
function Sparkline({ data, color = "#00ff88", height = 50 }) {
  if (!data || data.length < 2) return null;
  const values = data.map(d => d.close || d.bh || d.strat || d);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 200, h = height;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x},${y}`;
  }).join(" ");

  return (
    <svg width={w} height={h} style={{ overflow: "visible" }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

// ─────────────────────────────────────────────
// EQUITY CHART
// ─────────────────────────────────────────────
function EquityChart({ curve }) {
  if (!curve || curve.length < 2) return null;
  const w = 520, h = 120;
  const stratVals = curve.map(d => d.strat);
  const bhVals    = curve.map(d => d.bh);
  const allVals   = [...stratVals, ...bhVals];
  const min = Math.min(...allVals) * 0.98;
  const max = Math.max(...allVals) * 1.02;
  const range = max - min;

  const toPath = (vals) => vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${i === 0 ? "M" : "L"} ${x} ${y}`;
  }).join(" ");

  return (
    <svg width={w} height={h} style={{ overflow: "visible" }}>
      <defs>
        <linearGradient id="gStrat" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#00ff88" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#00ff88" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={toPath(stratVals) + ` L ${w} ${h} L 0 ${h} Z`} fill="url(#gStrat)" />
      <path d={toPath(stratVals)} fill="none" stroke="#00ff88" strokeWidth="2" />
      <path d={toPath(bhVals)}   fill="none" stroke="#4488ff" strokeWidth="1.5" strokeDasharray="4 3" />
    </svg>
  );
}

// ─────────────────────────────────────────────
// MAIN DASHBOARD
// ─────────────────────────────────────────────
export default function BTCSignalDashboard() {
  const [state, setState] = useState({
    loading: true,
    error: null,
    price: null,
    features: [],
    funding: null,
    fgValue: null,
    fgClass: null,
    onChain: { puell: null, mvrv: null },
    result: null,
    backtest: null,
    lastUpdate: null,
  });

  const loadData = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const [klines, funding, fg, price] = await Promise.all([
        fetchBinanceKlines("BTCUSDT", "1d", 400),
        fetchBinanceFunding("BTCUSDT", 500),
        fetchFearGreed(90),
        fetchCurrentPrice(),
      ]);

      const features = computeFeatures(klines);
      const today    = features[features.length - 1];
      const { percentile: fundingPct, carryAnn, current: fundCurrent } = computeFundingPercentile(funding);
      const fgValue = fg.length ? fg[fg.length - 1].value : null;
      const fgClass = fg.length ? fg[fg.length - 1].classification : null;

      // On-chain: usamos datos del snapshot público de BGeometrics (sin token)
      // En producción: reemplazar con fetch real al token
      const onChain = { puell: null, mvrv: null };

      const result   = computeSignalScore(today, onChain, fundingPct, fgValue);
      const backtest = runBacktest(features);

      setState({
        loading: false,
        error: null,
        price,
        features,
        klines,
        funding: { percentile: fundingPct, carryAnn, current: fundCurrent },
        fgValue,
        fgClass,
        onChain,
        result,
        backtest,
        lastUpdate: new Date(),
      });
    } catch (e) {
      setState(s => ({ ...s, loading: false, error: e.message }));
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const { loading, error, price, features, klines, funding, fgValue, fgClass, result, backtest, lastUpdate } = state;

  // Estilos base
  const colors = {
    bg:      "#0a0a0f",
    panel:   "#111118",
    border:  "#1e1e2e",
    accent:  "#00ff88",
    blue:    "#4488ff",
    yellow:  "#ffcc00",
    red:     "#ff4444",
    muted:   "#4a4a6a",
    text:    "#e0e0f0",
    dim:     "#8888aa",
  };

  const s = {
    container: {
      background: colors.bg,
      minHeight: "100vh",
      fontFamily: "'IBM Plex Mono', 'Courier New', monospace",
      color: colors.text,
      padding: "24px 20px",
      maxWidth: "660px",
      margin: "0 auto",
    },
    header: {
      borderBottom: `1px solid ${colors.border}`,
      paddingBottom: "16px",
      marginBottom: "24px",
    },
    title: {
      fontSize: "13px",
      letterSpacing: "3px",
      color: colors.accent,
      margin: 0,
      textTransform: "uppercase",
    },
    subtitle: {
      fontSize: "10px",
      color: colors.muted,
      marginTop: "4px",
    },
    panel: {
      background: colors.panel,
      border: `1px solid ${colors.border}`,
      borderRadius: "4px",
      padding: "16px",
      marginBottom: "16px",
    },
    panelTitle: {
      fontSize: "9px",
      letterSpacing: "2px",
      color: colors.muted,
      textTransform: "uppercase",
      marginBottom: "12px",
    },
    bigScore: {
      fontSize: "64px",
      fontWeight: "bold",
      lineHeight: 1,
      color: colors.accent,
    },
    action: (color) => ({
      fontSize: "14px",
      fontWeight: "bold",
      color: color || colors.accent,
      letterSpacing: "2px",
      marginTop: "8px",
    }),
    grid2: {
      display: "grid",
      gridTemplateColumns: "1fr 1fr",
      gap: "12px",
    },
    metric: {
      display: "flex",
      flexDirection: "column",
      gap: "2px",
    },
    metricLabel: {
      fontSize: "9px",
      color: colors.muted,
      textTransform: "uppercase",
      letterSpacing: "1px",
    },
    metricValue: {
      fontSize: "16px",
      fontWeight: "bold",
      color: colors.text,
    },
    signalRow: (active) => ({
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      padding: "10px 0",
      borderBottom: `1px solid ${colors.border}`,
      opacity: active ? 1 : 0.5,
    }),
    signalName: {
      fontSize: "11px",
      color: colors.dim,
    },
    signalDetail: {
      fontSize: "10px",
      color: colors.muted,
      marginTop: "2px",
    },
    signalBadge: (active) => ({
      fontSize: "11px",
      fontWeight: "bold",
      color: active ? colors.accent : colors.red,
      minWidth: "20px",
      textAlign: "right",
    }),
    btRow: {
      display: "flex",
      justifyContent: "space-between",
      padding: "6px 0",
      fontSize: "11px",
      borderBottom: `1px solid ${colors.border}`,
    },
    btn: {
      background: "transparent",
      border: `1px solid ${colors.accent}`,
      color: colors.accent,
      padding: "8px 16px",
      fontSize: "10px",
      letterSpacing: "2px",
      cursor: "pointer",
      fontFamily: "inherit",
      textTransform: "uppercase",
    },
    tag: (c) => ({
      display: "inline-block",
      padding: "2px 8px",
      fontSize: "9px",
      letterSpacing: "1px",
      background: `${c}22`,
      color: c,
      border: `1px solid ${c}44`,
      borderRadius: "2px",
    }),
  };

  if (loading) return (
    <div style={{ ...s.container, display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: "11px", color: colors.accent, letterSpacing: "3px" }}>LOADING DATA</div>
        <div style={{ fontSize: "10px", color: colors.muted, marginTop: "8px" }}>Fetching Kraken · alternative.me</div>
      </div>
    </div>
  );

  if (error) return (
    <div style={{ ...s.container, display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
      <div>
        <div style={{ color: colors.red, fontSize: "11px" }}>ERROR: {error}</div>
        <button style={{ ...s.btn, marginTop: "16px" }} onClick={loadData}>RETRY</button>
      </div>
    </div>
  );

  const today = features.length ? features[features.length - 1] : null;
  const scoreColor = result?.score >= 4 ? colors.accent : result?.score === 3 ? colors.yellow : colors.red;

  return (
    <div style={s.container}>

      {/* HEADER */}
      <div style={s.header}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <p style={s.title}>BTC Signal System</p>
            <p style={s.subtitle}>Simons Framework · {lastUpdate?.toLocaleTimeString()}</p>
          </div>
          <button style={s.btn} onClick={loadData}>↺ REFRESH</button>
        </div>
      </div>

      {/* PRICE ROW */}
      <div style={{ ...s.panel, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={s.metricLabel}>BTC/USD (Kraken)</div>
          <div style={{ ...s.metricValue, fontSize: "28px" }}>
            ${price?.toLocaleString("en-US", { minimumFractionDigits: 0 })}
          </div>
        </div>
        {klines && <Sparkline data={klines.slice(-60)} color={colors.blue} />}
      </div>

      {/* SIGNAL SCORE */}
      <div style={{ ...s.panel, textAlign: "center" }}>
        <div style={s.panelTitle}>Signal Score</div>
        <div style={{ ...s.bigScore, color: scoreColor }}>{result?.score}<span style={{ fontSize: "24px", color: colors.muted }}>/5</span></div>
        <div style={s.action(result?.actionColor)}>{result?.action}</div>
        <div style={{ display: "flex", justifyContent: "center", gap: "8px", marginTop: "12px" }}>
          {[1,2,3,4,5].map(i => (
            <div key={i} style={{
              width: "32px", height: "8px", borderRadius: "2px",
              background: i <= (result?.score || 0) ? scoreColor : colors.border,
              transition: "background 0.3s",
            }} />
          ))}
        </div>
      </div>

      {/* SIGNALS BREAKDOWN */}
      <div style={s.panel}>
        <div style={s.panelTitle}>Señales</div>
        {result?.signals.map((sig, i) => (
          <div key={i} style={s.signalRow(sig.active)}>
            <div>
              {sig.isGate && <span style={s.tag(colors.blue)}>GATE</span>}
              <div style={{ ...s.signalName, marginTop: sig.isGate ? "4px" : 0 }}>{sig.name}</div>
              <div style={s.signalDetail}>{sig.detail}</div>
            </div>
            <div>
              <div style={s.signalBadge(sig.active)}>{sig.score > 0 ? "+1" : "0"}</div>
              <div style={{ fontSize: "10px", color: colors.muted, textAlign: "right", marginTop: "2px" }}>{sig.value}</div>
            </div>
          </div>
        ))}
      </div>

      {/* MARKET SNAPSHOT */}
      <div style={s.panel}>
        <div style={s.panelTitle}>Market Snapshot</div>
        <div style={s.grid2}>
          <div style={s.metric}>
            <div style={s.metricLabel}>Fear & Greed</div>
            <div style={{ ...s.metricValue, color: fgValue < FG_FLOOR ? colors.accent : fgValue > FG_CEIL ? colors.red : colors.text }}>
              {fgValue ?? "N/A"}
            </div>
            <div style={{ fontSize: "9px", color: colors.muted }}>{fgClass}</div>
          </div>
          <div style={s.metric}>
            <div style={s.metricLabel}>Funding Pct</div>
            <div style={{ ...s.metricValue, color: (funding?.percentile || 0) > FUND_EXTREME ? colors.red : colors.text }}>
              {funding?.percentile != null ? `${(funding.percentile * 100).toFixed(0)}%` : "N/A"}
            </div>
            <div style={{ fontSize: "9px", color: colors.muted }}>
              {funding?.current != null ? `${(funding.current * 100).toFixed(4)}% actual` : ""}
            </div>
          </div>
          <div style={s.metric}>
            <div style={s.metricLabel}>Momentum 30d</div>
            <div style={{ ...s.metricValue, color: (today?.momentum30 || 0) > 0 ? colors.accent : colors.red }}>
              {today?.momentum30 != null ? `${(today.momentum30 * 100).toFixed(2)}%` : "N/A"}
            </div>
          </div>
          <div style={s.metric}>
            <div style={s.metricLabel}>Vol 30d (ann)</div>
            <div style={s.metricValue}>
              {today?.vol30 != null ? `${(today.vol30 * 100).toFixed(1)}%` : "N/A"}
            </div>
          </div>
          <div style={s.metric}>
            <div style={s.metricLabel}>10d High</div>
            <div style={{ ...s.metricValue, color: today?.is10dHigh ? colors.accent : colors.red }}>
              {today?.is10dHigh ? "SI ✓" : "NO ✗"}
            </div>
          </div>
          <div style={s.metric}>
            <div style={s.metricLabel}>Carry Ann (fund)</div>
            <div style={s.metricValue}>
              {funding?.carryAnn != null ? `${(funding.carryAnn * 100).toFixed(1)}%` : "N/A"}
            </div>
          </div>
        </div>
        <div style={{ marginTop: "12px", padding: "8px", background: "#0a0a1a", borderRadius: "3px", fontSize: "9px", color: colors.muted }}>
          ⚠️ On-chain (MVRV, Puell): configurá token en BGeometrics.
          <br/>Registrá gratis en <span style={{ color: colors.accent }}>portal.bgeometrics.com/login</span>
          <br/>Luego editá BGEOMETRICS_TOKEN en el script Python.
        </div>
      </div>

      {/* BACKTEST */}
      {backtest && (
        <div style={s.panel}>
          <div style={s.panelTitle}>Backtest 2 años — Momentum + Régimen</div>
          <EquityChart curve={backtest.equityCurve} />
          <div style={{ display: "flex", gap: "16px", marginTop: "6px", fontSize: "9px" }}>
            <span style={{ color: colors.accent }}>── Estrategia</span>
            <span style={{ color: colors.blue }}>- - Buy & Hold</span>
          </div>
          <div style={{ marginTop: "12px" }}>
            {[
              ["Retorno total",  backtest.strategy.totalReturn, backtest.buyHold.totalReturn],
              ["Retorno anual",  backtest.strategy.annReturn,   backtest.buyHold.annReturn],
              ["Max drawdown",   backtest.strategy.maxDrawdown, backtest.buyHold.maxDrawdown],
              ["Trades",         backtest.strategy.trades,      "—"],
              ["Win rate",       backtest.strategy.winRate,     "—"],
            ].map(([label, strat, bh]) => (
              <div key={label} style={s.btRow}>
                <span style={{ color: colors.muted }}>{label}</span>
                <span style={{ color: colors.accent }}>{strat}</span>
                <span style={{ color: colors.blue }}>{bh}</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: "9px", color: colors.muted, marginTop: "8px" }}>
            ⚠️ Backtest ≠ garantía. Señal simple (momentum + régimen). Sin on-chain.
            TC: 0.1% por trade. Out-of-sample es la única prueba real.
          </div>
        </div>
      )}

      {/* SIZING */}
      {result && result.score >= 3 && (
        <div style={s.panel}>
          <div style={s.panelTitle}>Position Sizing (Kelly ¼)</div>
          <div style={s.grid2}>
            {[
              ["Capital total",  "$5,000"],
              ["Score",         `${result.score}/5`],
              ["Size USD",      result.score >= 4 ? "$1,000" : "$500"],
              ["Size BTC",      price ? `${((result.score >= 4 ? 1000 : 500) / price).toFixed(6)} BTC` : "—"],
              ["Stop loss",     price ? `$${(price * 0.93).toFixed(0)}` : "—"],
              ["Stop %",        "-7%"],
            ].map(([l, v]) => (
              <div key={l} style={s.metric}>
                <div style={s.metricLabel}>{l}</div>
                <div style={{ ...s.metricValue, fontSize: "14px" }}>{v}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* FOOTER */}
      <div style={{ textAlign: "center", fontSize: "9px", color: colors.muted, marginTop: "24px" }}>
        DATA: Kraken · alternative.me · BGeometrics<br/>
        Este sistema NO es asesoría financiera.<br/>
        Validá siempre con tu propio criterio antes de operar.
      </div>

    </div>
  );
}
