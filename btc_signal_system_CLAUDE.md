# BTC Signal System — Documentación Técnica

## Qué hace

Sistema de detección de señales para BTC inspirado en los principios cuantitativos de Jim Simons (Medallion Fund). Combina 5 señales independientes en un score 0–5, ejecuta un backtest vectorizado de 2 años, y calcula el tamaño de posición via Kelly ¼.

No es un bot de trading automático — genera un reporte diario para decisiones manuales.

---

## Archivos

```
btc_signal_system.py        # Script principal Python
btc_signal_dashboard.jsx    # Dashboard React (opcional, mismo sistema)
requirements.txt            # Dependencias Python
```

---

## Cómo correr

```bash
# Crear entorno virtual e instalar dependencias
python3 -m venv .venv
source .venv/bin/activate        # Linux/Mac
# .venv\Scripts\activate         # Windows

pip install -r requirements.txt

# Correr el sistema
python btc_signal_system.py
```

El script imprime el signal report completo y el backtest.

---

## Fuentes de datos

| Fuente | Datos | Auth |
|---|---|---|
| **Kraken API** | OHLCV diario (400 días), precio actual | Sin auth |
| **alternative.me** | Fear & Greed Index (90 días histórico) | Sin auth |
| **BGeometrics** | MVRV Z-Score, Puell Multiple, SOPR | Token gratis requerido |

> **Nota:** Binance Futures API (fapi.binance.com) devuelve 451 desde ciertos
> servidores cloud por restricciones geográficas. El sistema usa Kraken como
> fuente primaria de OHLCV.

### Configurar BGeometrics (opcional pero recomendado)

1. Registrarse gratis en https://portal.bgeometrics.com/login
2. Copiar el token API
3. Editar `btc_signal_system.py` línea 22:
   ```python
   BGEOMETRICS_TOKEN = "tu_token_aqui"
   ```

Sin el token, las señales 3 (Cycle Position) se omite del score.

---

## El sistema de señales

### Score compuesto 0–5

Cada señal aporta 0 o 1 punto:

| # | Señal | Fuente | Descripción |
|---|---|---|---|
| 1 | **Régimen 10-Day High** (GATE) | Kraken OHLCV | BTC debe estar en nuevo máximo de 10 días. Si está OFF, el score va directo a 0. |
| 2 | **TS Momentum 30d** | Kraken OHLCV | Suma log-returns de los últimos 30 días debe ser positiva. |
| 3 | **Cycle Position (On-Chain)** | BGeometrics | Puell Multiple < 4.0 y MVRV Z-Score < 3.5. Se omite sin token. |
| 4 | **Fear & Greed Contrarian** | alternative.me | Neutral o Extreme Fear = alcista. Extreme Greed (>80) = precaución. |
| 5 | **Funding Rate Percentile** | Binance/Kraken Futures | Percentil vs histórico. Funding extremo (>95%) = mean reversion risk. |

### Decisión por score

| Score | Acción | Tamaño |
|---|---|---|
| 4–5 | LONG FULL SIZE | 20% del capital (Kelly-ajustado) |
| 3 | LONG HALF SIZE | 10% del capital |
| 0–2 | CASH | Sin posición |

---

## Feature engineering

Calculado sobre los últimos 400 días de OHLCV diario:

- `log_return`: log(close_t / close_{t-1})
- `momentum_30d`: suma de log_returns rolling 30 días
- `vol_30d`: std rolling 30d × √365 (volatilidad anualizada)
- `mom_vol_adj`: momentum / volatilidad (risk-adjusted signal)
- `is_10d_high`: 1 si close > max(close[-10:-1]) — sin look-ahead (shift=1)
- `bb_position`: posición dentro de Bollinger Bands 20d (0=lower, 1=upper)
- `drawdown_pct`: distancia porcentual desde el ATH

---

## Backtest vectorizado

El backtest usa la señal simple (régimen + momentum, sin on-chain) para poder
correr sobre el histórico completo sin necesidad de token BGeometrics.

**Metodología:**
- Entrada/salida al día siguiente del signal (para evitar look-ahead)
- Posición long-only (0 o 1)
- Costo de transacción: 0.1% por trade
- Ventana: últimos 2 años

**Limitaciones conocidas:**
- `win_rate` en el output Python cuenta "días ganadores / total días" incluyendo
  días en cash (win rate = 0 esos días). El número real de trades ganadores
  es mayor al que aparece.
- Sin costos de slippage ni financiamiento de margen.
- Backtest corto (2 años) — insuficiente para validación estadística robusta.

---

## Position sizing (Kelly ¼)

```
Kelly completo = (p × b - q) / b
  donde b = avg_win / avg_loss
        p = win_rate estimado
        q = 1 - p

Kelly ajustado = Kelly completo × 0.25   (1/4 Kelly, conservador)
Posición USD   = min(capital × Kelly_adj, capital × 20%)
```

Las estimaciones de win_rate y avg_win/loss son baseline conservadoras
(~52–60% win rate, ~2.5–4% avg win, 2% avg loss) escaladas con el score.

---

## Dashboard React (btc_signal_dashboard.jsx)

Componente React standalone que replica el mismo sistema en el browser.
Llama directamente a las APIs públicas (Kraken, alternative.me) desde el cliente.

**Para usar:**
- Requiere un entorno React (Vite, Create React App, Next.js, etc.)
- No tiene dependencias externas — solo React hooks estándar
- Las mismas fuentes de datos que el script Python
- Funding rate N/A (Binance Futures geo-restringido desde muchos servidores)

---

## Umbrales configurables

En `btc_signal_system.py`:

```python
CAPITAL_USD       = 5000     # Capital total
MAX_POSITION_PCT  = 0.20     # Máx 20% por trade
KELLY_FRACTION    = 0.25     # 1/4 Kelly
TC_PCT            = 0.001    # Costo 0.1% por trade

PUELL_CAUTION     = 2.0      # Puell > 2 = precaución
PUELL_EUPHORIA    = 4.0      # Puell > 4 = techo
MVRV_CAUTION      = 3.5      # MVRV Z > 3.5 = sobrevalorado
FEAR_GREED_FLOOR  = 20       # < 20 = extreme fear (contrarian bull)
FEAR_GREED_CEIL   = 80       # > 80 = extreme greed (precaución)
FUNDING_EXTREME   = 0.95     # Percentil > 95% = mean reversion
```

---

## Advertencia

Este sistema es experimental y educativo. **No es asesoría financiera.**
Los backtests no garantizan rendimientos futuros. Validá siempre con tu
propio criterio antes de operar capital real.
