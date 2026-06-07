"""
BTC Signal Detection System — Estilo Jim Simons
================================================
Fuentes de data:
  - Binance Futures API (OHLCV, funding rate) — sin auth
  - BGeometrics API (MVRV, Puell, SOPR, Fear&Greed) — token gratis en portal.bgeometrics.com
  - alternative.me (Fear & Greed histórico) — sin auth

Señales implementadas:
  1. Regime Filter: 10-day high momentum
  2. TS Momentum: rolling 30d log-return
  3. Cycle Position: Puell Multiple + MVRV Z-Score
  4. Sentiment Contrarian: Fear & Greed
  5. Funding Rate: percentil vs histórico

Cómo correr:
  pip install requests pandas numpy scipy
  python btc_signal_system.py

  Para BGeometrics: registrate en https://portal.bgeometrics.com/login
  y pegá tu token en BGEOMETRICS_TOKEN abajo.
"""

import requests
import pandas as pd
import numpy as np
from scipy import stats
from datetime import datetime, timezone
import time
import json

# ─────────────────────────────────────────────
# CONFIGURACIÓN
# ─────────────────────────────────────────────
BGEOMETRICS_TOKEN = "YOUR_TOKEN_HERE"   # Registrá en portal.bgeometrics.com
CAPITAL_USD       = 5000                # Capital total disponible
MAX_POSITION_PCT  = 0.20               # Max 20% del capital por trade
KELLY_FRACTION    = 0.25               # Kelly conservador (1/4 Kelly)
TC_PCT            = 0.001             # Costo por trade (0.1%)

# Umbrales de señales (basados en evidencia empírica)
PUELL_CAUTION     = 2.0               # Puell > 2 = zona de precaución
PUELL_EUPHORIA    = 4.0               # Puell > 4 = zona de techo
MVRV_CAUTION      = 3.5               # MVRV Z-Score > 3.5 = sobrevalorado
FEAR_GREED_FLOOR  = 20                # < 20 = extreme fear (contrarian bull)
FEAR_GREED_CEIL   = 80                # > 80 = extreme greed (precaución)
FUNDING_CAUTION   = 0.75              # Percentil histórico > 75% = caliente
FUNDING_EXTREME   = 0.95              # Percentil > 95% = mean reversion opp


# ─────────────────────────────────────────────
# CAPA 1: DATA FETCHERS
# ─────────────────────────────────────────────

def fetch_binance_klines(symbol="BTCUSDT", interval="1d", limit=365):
    """
    OHLCV diario desde Kraken (Binance geo-restricts some server locations).
    symbol/interval/limit ignorados — siempre devuelve BTC/USD diario, hasta 720 velas.
    """
    since = int(time.time()) - limit * 86400
    url = f"https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440&since={since}"
    try:
        r = requests.get(url, timeout=10)
        r.raise_for_status()
        d = r.json()
        if d.get("error"):
            raise ValueError(d["error"])
        candles = d["result"]["XXBTZUSD"]
        # format: [timestamp, open, high, low, close, vwap, volume, count]
        df = pd.DataFrame(candles, columns=[
            "open_time", "open", "high", "low", "close", "vwap", "volume", "count"
        ])
        df["close"]  = df["close"].astype(float)
        df["high"]   = df["high"].astype(float)
        df["low"]    = df["low"].astype(float)
        df["open"]   = df["open"].astype(float)
        df["volume"] = df["volume"].astype(float)
        df["date"]   = pd.to_datetime(df["open_time"].astype(np.int64), unit="s")
        df = df.set_index("date").sort_index()
        return df
    except Exception as e:
        print(f"[ERROR] Kraken klines: {e}")
        return pd.DataFrame()


def fetch_binance_funding(symbol="BTCUSDT", limit=500):
    """
    Funding rate histórico desde Binance Futures.
    Requiere acceso a fapi.binance.com (puede estar geo-restringido en servidores cloud).
    Sin acceso, la señal de funding se omite del score automáticamente.
    """
    url = "https://fapi.binance.com/fapi/v1/fundingRate"
    params = {"symbol": symbol, "limit": limit}
    try:
        r = requests.get(url, params=params, timeout=10)
        if r.status_code == 451:
            print("  [SKIP] Funding rate — Binance Futures geo-restringido en este servidor")
            return pd.DataFrame()
        r.raise_for_status()
        data = r.json()
        df = pd.DataFrame(data)
        df["fundingRate"] = df["fundingRate"].astype(float)
        df["date"] = pd.to_datetime(df["fundingTime"], unit="ms")
        df = df.set_index("date").sort_index()
        return df
    except Exception as e:
        if "451" not in str(e):
            print(f"  [SKIP] Funding rate: {e}")
        return pd.DataFrame()


def fetch_bgeometrics(metric, token=BGEOMETRICS_TOKEN):
    """
    On-chain metrics desde BGeometrics.
    Métricas disponibles: mvrv, puell_multiple, sopr, nupl,
    realized_price, hashrate, exchange_netflow, funding_rate, etc.
    Token gratis: portal.bgeometrics.com/login
    """
    if token == "YOUR_TOKEN_HERE":
        print(f"[SKIP] BGeometrics token no configurado. Métrica: {metric}")
        return None

    url = f"https://api.bgeometrics.com/v1/{metric}"
    headers = {"Authorization": f"Bearer {token}"}
    try:
        r = requests.get(url, headers=headers, timeout=10)
        r.raise_for_status()
        data = r.json()
        # La respuesta es lista de [timestamp, value]
        if isinstance(data, list) and len(data) > 0:
            df = pd.DataFrame(data, columns=["timestamp", "value"])
            df["date"] = pd.to_datetime(df["timestamp"], unit="s")
            df = df.set_index("date").sort_index()
            df["value"] = pd.to_numeric(df["value"], errors="coerce")
            return df
        return None
    except Exception as e:
        print(f"[ERROR] BGeometrics {metric}: {e}")
        return None


def fetch_fear_greed(limit=365):
    """Fear & Greed Index histórico. Sin auth. Fuente: alternative.me"""
    url = f"https://api.alternative.me/fng/?limit={limit}&format=json"
    try:
        r = requests.get(url, timeout=10)
        r.raise_for_status()
        data = r.json()["data"]
        df = pd.DataFrame(data)
        df["value"] = df["value"].astype(int)
        # cast explícito a int64 antes de pasarlo a to_datetime
        # (pandas 2.x interpreta strings numéricos como año si no se fuerza el tipo)
        df["date"] = pd.to_datetime(df["timestamp"].astype(np.int64), unit="s")
        df = df.set_index("date").sort_index()
        return df
    except Exception as e:
        print(f"[ERROR] Fear & Greed: {e}")
        return pd.DataFrame()


def fetch_current_price():
    """Precio actual BTC desde Kraken (Binance geo-restringido en algunos servidores)."""
    try:
        r = requests.get("https://api.kraken.com/0/public/Ticker?pair=XBTUSD", timeout=5)
        data = r.json()
        return float(data["result"]["XXBTZUSD"]["c"][0])
    except:
        return None


# ─────────────────────────────────────────────
# CAPA 2: FEATURE ENGINEERING
# ─────────────────────────────────────────────

def compute_features(df_price):
    """Calcula todas las features sobre el DataFrame de precios."""
    df = df_price.copy()

    # Log returns
    df["log_return"] = np.log(df["close"] / df["close"].shift(1))

    # Time-series momentum: rolling sum 30d
    df["momentum_30d"] = df["log_return"].rolling(30).sum()

    # Volatilidad realizada 30d (annualizada)
    df["vol_30d"] = df["log_return"].rolling(30).std() * np.sqrt(365)

    # Momentum ajustado por volatilidad (Sharpe de la señal)
    df["mom_vol_adj"] = df["momentum_30d"] / (df["vol_30d"] + 1e-8)

    # 10-day high (shift para no look-ahead)
    df["high_10d"] = df["close"].rolling(10).max().shift(1)
    df["is_10d_high"] = (df["close"] > df["high_10d"]).astype(int)

    # Bollinger Bands (20d, 2σ)
    df["sma_20"] = df["close"].rolling(20).mean()
    df["std_20"] = df["close"].rolling(20).std()
    df["bb_upper"] = df["sma_20"] + 2 * df["std_20"]
    df["bb_lower"] = df["sma_20"] - 2 * df["std_20"]
    df["bb_position"] = (df["close"] - df["bb_lower"]) / (df["bb_upper"] - df["bb_lower"])

    # Drawdown desde ATH
    df["ath"] = df["close"].cummax()
    df["drawdown_pct"] = (df["close"] - df["ath"]) / df["ath"]

    return df


def compute_funding_percentile(df_funding):
    """Calcula el percentil actual del funding rate vs histórico."""
    if df_funding.empty:
        return None, None

    rates = df_funding["fundingRate"].dropna()
    current = rates.iloc[-1]

    # Percentil actual
    percentile = stats.percentileofscore(rates, current) / 100.0

    # Media rolling 30 días (annualizada como carry)
    # Funding se paga 3 veces al día = ~1095 veces/año
    daily_rate = rates.resample('D').mean()
    carry_annualized = daily_rate.tail(30).mean() * 3 * 365

    return percentile, carry_annualized


# ─────────────────────────────────────────────
# CAPA 3: SCORING DE SEÑALES
# ─────────────────────────────────────────────

def compute_signal_score(features_today, on_chain, funding_pct, fg_value):
    """
    Calcula el score compuesto 0-5 del sistema de señales.

    Retorna: (score, detalle_por_señal, acción_recomendada)
    """
    score = 0
    details = {}

    # ── SEÑAL 1: RÉGIMEN (10-day high) ──
    regime_on = features_today.get("is_10d_high", 0) == 1
    details["regime"] = {
        "name": "10-Day High Regime",
        "value": "ON" if regime_on else "OFF",
        "signal": 1 if regime_on else 0,
        "weight": "GATE — si está OFF, no entramos"
    }

    # Si el régimen está apagado, score directo a 0
    if not regime_on:
        return 0, details, "CASH — Régimen OFF (no nuevo máximo 10d)"

    score += 1  # 1 punto por régimen ON

    # ── SEÑAL 2: MOMENTUM TS ──
    mom = features_today.get("momentum_30d", 0)
    mom_signal = 1 if mom > 0 else 0
    score += mom_signal
    details["momentum"] = {
        "name": "TS Momentum 30d",
        "value": f"{mom:.4f}",
        "signal": mom_signal,
        "interpretation": "Positivo ✓" if mom_signal else "Negativo ✗"
    }

    # ── SEÑAL 3: CYCLE POSITION (On-Chain) ──
    puell = on_chain.get("puell_multiple")
    mvrv  = on_chain.get("mvrv_zscore")

    cycle_ok = True
    cycle_notes = []

    if puell is not None:
        if puell > PUELL_EUPHORIA:
            cycle_ok = False
            cycle_notes.append(f"Puell={puell:.2f} > {PUELL_EUPHORIA} (TECHO)")
        elif puell > PUELL_CAUTION:
            cycle_notes.append(f"Puell={puell:.2f} — precaución")
        else:
            cycle_notes.append(f"Puell={puell:.2f} ✓ acumulación")

    if mvrv is not None:
        if mvrv > MVRV_CAUTION:
            cycle_ok = False
            cycle_notes.append(f"MVRV={mvrv:.2f} > {MVRV_CAUTION} (SOBREVALORADO)")
        else:
            cycle_notes.append(f"MVRV={mvrv:.2f} ✓")

    cycle_signal = 1 if cycle_ok else 0
    score += cycle_signal
    details["cycle"] = {
        "name": "Cycle Position (On-Chain)",
        "signal": cycle_signal,
        "notes": cycle_notes
    }

    # ── SEÑAL 4: SENTIMENT CONTRARIAN ──
    if fg_value is not None:
        if fg_value < FEAR_GREED_FLOOR:
            sent_signal = 1
            sent_note = f"Fear&Greed={fg_value} — Extreme Fear → contrarian bull ✓"
        elif fg_value > FEAR_GREED_CEIL:
            sent_signal = 0
            sent_note = f"Fear&Greed={fg_value} — Extreme Greed → precaución ✗"
        else:
            sent_signal = 1
            sent_note = f"Fear&Greed={fg_value} — neutral ✓"

        score += sent_signal
        details["sentiment"] = {
            "name": "Fear & Greed Contrarian",
            "value": fg_value,
            "signal": sent_signal,
            "note": sent_note
        }

    # ── SEÑAL 5: FUNDING RATE ──
    if funding_pct is not None:
        if funding_pct > FUNDING_EXTREME:
            fund_signal = 0
            fund_note = f"Funding pct={funding_pct:.2f} — EXTREMO, posible reversal ✗"
        elif funding_pct < 0.25:
            fund_signal = 1
            fund_note = f"Funding pct={funding_pct:.2f} — bajo, sin exceso ✓"
        else:
            fund_signal = 1
            fund_note = f"Funding pct={funding_pct:.2f} — normal ✓"

        score += fund_signal
        details["funding"] = {
            "name": "Funding Rate Percentile",
            "value": f"{funding_pct:.2%}",
            "signal": fund_signal,
            "note": fund_note
        }

    # ── DECISIÓN FINAL ──
    if score >= 4:
        action = f"LONG — Score {score}/5 — Full size ({MAX_POSITION_PCT*100:.0f}% capital)"
    elif score == 3:
        action = f"LONG — Score {score}/5 — Half size ({MAX_POSITION_PCT*50:.0f}% capital)"
    else:
        action = f"CASH — Score {score}/5 — Insuficiente evidencia"

    return score, details, action


# ─────────────────────────────────────────────
# CAPA 4: SIZING (Kelly conservador)
# ─────────────────────────────────────────────

def kelly_size(win_rate, avg_win, avg_loss, capital, fraction=KELLY_FRACTION):
    """
    Kelly fraction = (p * b - q) / b
    donde b = avg_win/avg_loss, p = win_rate, q = 1-p
    Usamos 1/4 Kelly para ser conservadores.
    """
    if avg_loss == 0:
        return 0
    b = avg_win / avg_loss
    q = 1 - win_rate
    kelly_full = (win_rate * b - q) / b
    kelly_adj  = max(0, kelly_full * fraction)
    max_size   = capital * MAX_POSITION_PCT
    position   = min(capital * kelly_adj, max_size)
    return position


def compute_position_size(score, capital, current_price):
    """Calcula tamaño de posición en USD y BTC."""
    win_rate = 0.52 + (score / 5) * 0.08
    avg_win  = 0.025 + (score / 5) * 0.015
    avg_loss = 0.020

    usd_size = kelly_size(win_rate, avg_win, avg_loss, capital)

    if score >= 4:
        usd_size = min(usd_size, capital * MAX_POSITION_PCT)
    elif score == 3:
        usd_size = min(usd_size, capital * MAX_POSITION_PCT * 0.5)
    else:
        usd_size = 0

    btc_size = usd_size / current_price if current_price else 0

    return {
        "usd": round(usd_size, 2),
        "btc": round(btc_size, 6),
        "win_rate_est": f"{win_rate:.1%}",
        "stop_loss_pct": -7.0,
        "stop_loss_usd": round(current_price * 0.93, 0) if current_price else None
    }


# ─────────────────────────────────────────────
# BACKTESTING VECTORIZADO
# ─────────────────────────────────────────────

def run_backtest(df, signal_col="signal"):
    """
    Backtest vectorizado sobre el DataFrame con señales.
    Asume entrada/salida al día siguiente del signal.
    """
    df = df.copy()
    df["log_ret_next"] = df["log_return"].shift(-1)

    # Posición basada en señal del día anterior (para evitar look-ahead)
    df["position"] = df[signal_col].shift(1).fillna(0)

    # Retornos de la estrategia
    df["strat_ret"] = df["position"] * df["log_ret_next"]

    # Costos de transacción
    df["trade"] = df["position"].diff().abs()
    df["strat_ret_net"] = df["strat_ret"] - df["trade"] * TC_PCT

    # Métricas
    net = df["strat_ret_net"].dropna()
    bh  = df["log_return"].dropna()

    ann = 365

    def sharpe(series):
        if series.std() == 0:
            return 0
        return (series.mean() * ann) / (series.std() * np.sqrt(ann))

    def max_drawdown(series):
        cumret = np.exp(series.cumsum())
        rolling_max = cumret.cummax()
        dd = (cumret - rolling_max) / rolling_max
        return dd.min()

    results = {
        "strategy": {
            "total_return":     f"{(np.exp(net.sum()) - 1) * 100:.1f}%",
            "ann_return":       f"{(np.exp(net.mean() * ann) - 1) * 100:.1f}%",
            "sharpe":           f"{sharpe(net):.2f}",
            "max_drawdown":     f"{max_drawdown(net) * 100:.1f}%",
            "trades":           int(df["trade"].sum() / 2),
            "win_rate":         f"{(net > 0).mean() * 100:.1f}%",
        },
        "buy_hold": {
            "total_return":     f"{(np.exp(bh.sum()) - 1) * 100:.1f}%",
            "ann_return":       f"{(np.exp(bh.mean() * ann) - 1) * 100:.1f}%",
            "sharpe":           f"{sharpe(bh):.2f}",
            "max_drawdown":     f"{max_drawdown(bh) * 100:.1f}%",
        }
    }

    return results, df


def build_simple_signal(df):
    """
    Señal simple para backtest: momentum 30d positivo + régimen 10d high.
    Sin on-chain (para backtest largo sin token BGeometrics).
    """
    df = df.copy()
    df["signal"] = 0

    regime_mask   = df["is_10d_high"] == 1
    momentum_mask = df["momentum_30d"] > 0

    df.loc[regime_mask & momentum_mask, "signal"] = 1

    return df


# ─────────────────────────────────────────────
# RUNNER PRINCIPAL
# ─────────────────────────────────────────────

def run_system():
    print("\n" + "="*60)
    print("  BTC SIGNAL SYSTEM — Simons Framework")
    print(f"  {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    print("="*60)

    # ── 1. FETCH DATA ──
    print("\n[1/4] Fetching data...")

    df_price   = fetch_binance_klines(interval="1d", limit=400)
    df_funding = fetch_binance_funding(limit=500)
    df_fg      = fetch_fear_greed(limit=90)
    price_now  = fetch_current_price()

    print(f"  ✓ Price klines: {len(df_price)} días")
    print(f"  ✓ Funding rate: {len(df_funding)} períodos")
    print(f"  ✓ Fear & Greed: {len(df_fg)} días")
    if price_now:
        print(f"  ✓ BTC price now: ${price_now:,.0f}")
    else:
        print("  ✗ Price fetch failed")

    # On-chain via BGeometrics (opcional)
    on_chain = {}
    if BGEOMETRICS_TOKEN != "YOUR_TOKEN_HERE":
        print("  Fetching on-chain metrics...")
        time.sleep(0.5)
        puell_df = fetch_bgeometrics("puell_multiple")
        time.sleep(0.5)
        mvrv_df  = fetch_bgeometrics("mvrv")

        if puell_df is not None:
            on_chain["puell_multiple"] = puell_df["value"].iloc[-1]
            print(f"  ✓ Puell Multiple: {on_chain['puell_multiple']:.3f}")
        if mvrv_df is not None:
            on_chain["mvrv_zscore"] = mvrv_df["value"].iloc[-1]
            print(f"  ✓ MVRV: {on_chain['mvrv_zscore']:.3f}")
    else:
        print("  [SKIP] BGeometrics — token no configurado")
        print("         → Configurá BGEOMETRICS_TOKEN para on-chain signals")

    if df_price.empty:
        print("\n[ERROR] No se pudo obtener data de precios. Verificá conexión.")
        return

    # ── 2. COMPUTE FEATURES ──
    print("\n[2/4] Computing features...")
    df = compute_features(df_price)

    # Funding percentile
    funding_pct, carry_ann = compute_funding_percentile(df_funding)

    # Fear & Greed actual
    fg_value = None
    if not df_fg.empty:
        fg_value = int(df_fg["value"].iloc[-1])

    print(f"  ✓ Features calculadas sobre {len(df)} días")
    if funding_pct:
        print(f"  ✓ Funding percentile: {funding_pct:.1%}")
    if fg_value:
        col = "value_classification"
        fg_class = df_fg[col].iloc[-1] if col in df_fg.columns else ""
        print(f"  ✓ Fear & Greed: {fg_value} ({fg_class})")

    # ── 3. BACKTEST ──
    print("\n[3/4] Running backtest (2 años)...")
    df_signal = build_simple_signal(df)

    cutoff = df_signal.index[-1] - pd.DateOffset(years=2)
    df_bt   = df_signal[df_signal.index >= cutoff].copy()

    bt_results, df_bt = run_backtest(df_bt)

    print("\n  ┌──────────────────────────────────────────┐")
    print("  │  BACKTEST 2 AÑOS (momentum + régimen)    │")
    print("  ├────────────────┬────────────┬────────────┤")
    print("  │ MÉTRICA        │ ESTRATEGIA │    B&H     │")
    print("  ├────────────────┼────────────┼────────────┤")
    for k in ["total_return", "ann_return", "sharpe", "max_drawdown"]:
        s = bt_results["strategy"][k]
        b = bt_results["buy_hold"][k]
        print(f"  │ {k:14s} │ {s:10s} │ {b:10s} │")
    print(f"  │ {'trades':14s} │ {bt_results['strategy']['trades']:10d} │ {'n/a':10s} │")
    print(f"  │ {'win_rate':14s} │ {bt_results['strategy']['win_rate']:10s} │ {'n/a':10s} │")
    print("  └────────────────┴────────────┴────────────┘")

    # ── 4. SEÑAL ACTUAL ──
    print("\n[4/4] Computing today's signal...")

    today = df.iloc[-1]
    features_today = {
        "is_10d_high":   int(today["is_10d_high"]),
        "momentum_30d":  float(today["momentum_30d"]),
        "vol_30d":       float(today["vol_30d"]),
        "mom_vol_adj":   float(today["mom_vol_adj"]),
        "bb_position":   float(today["bb_position"]),
        "drawdown_pct":  float(today["drawdown_pct"]),
        "close":         float(today["close"]),
    }

    score, details, action = compute_signal_score(
        features_today, on_chain, funding_pct, fg_value
    )

    ref_price = price_now or features_today["close"]
    sizing = compute_position_size(score, CAPITAL_USD, ref_price)

    # ── OUTPUT FINAL ──
    print("\n" + "="*60)
    print("  SIGNAL REPORT")
    print("="*60)
    print(f"\n  BTC Price:     ${ref_price:,.0f}")
    print(f"  Capital:       ${CAPITAL_USD:,.0f}")
    print(f"\n  SCORE TOTAL:   {score}/5")
    print(f"  ACTION:        {action}")

    print("\n  ── DETALLE POR SEÑAL ──")
    for key, det in details.items():
        sig_icon = "OK" if det.get("signal", 0) == 1 else "XX"
        print(f"\n  [{sig_icon}] {det['name']}")
        if "value" in det:
            print(f"       Valor: {det['value']}")
        if "interpretation" in det:
            print(f"       -> {det['interpretation']}")
        if "note" in det:
            print(f"       -> {det['note']}")
        if "notes" in det:
            for n in det["notes"]:
                print(f"       -> {n}")

    print("\n  ── SIZING ──")
    if score >= 3:
        print(f"  Position USD:  ${sizing['usd']:,.0f}")
        print(f"  Position BTC:  {sizing['btc']:.6f} BTC")
        print(f"  Win rate est:  {sizing['win_rate_est']}")
        if sizing['stop_loss_usd']:
            print(f"  Stop loss:     ${sizing['stop_loss_usd']:,.0f} ({sizing['stop_loss_pct']}%)")
    else:
        print("  Sin posición (score insuficiente)")

    if carry_ann:
        print(f"\n  Carry (funding 30d ann): {carry_ann:.1%}")

    print("\n" + "="*60)
    print("  AVISO: Esto NO es asesoria financiera.")
    print("  Valida siempre con tu propio criterio antes de operar.")
    print("="*60 + "\n")

    return {
        "score": score,
        "action": action,
        "details": details,
        "sizing": sizing,
        "backtest": bt_results,
        "features": features_today,
        "on_chain": on_chain
    }


if __name__ == "__main__":
    result = run_system()
