#!/usr/bin/env python3
"""BTC chart — VWAP cloud + индикаторы под легендой"""
import pandas as pd
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import mplfinance as mpf
from datetime import datetime, timezone, timedelta

SYMBOL = 'BTC/USDT'
PERIOD_DAYS = 14

csv_path = r'C:\Users\Cryptodatex\Desktop\TA\binance_spot_BTCUSDT_1h_20260301_to_20260715.csv'
df = pd.read_csv(csv_path)
df['Date'] = pd.to_datetime(df['open_time_utc'])
df = df.sort_values('Date')
cutoff = df['Date'].max() - pd.Timedelta(days=PERIOD_DAYS)
df = df[df['Date'] >= cutoff].copy()

# Store raw OHLCV before renaming
high_raw = df['high'].values
low_raw = df['low'].values
close_raw = df['close'].values
volume_raw = df['volume'].values

df.set_index('Date', inplace=True)
df = df.rename(columns={
    'open': 'Open', 'high': 'High', 'low': 'Low',
    'close': 'Close', 'volume': 'Volume'
})[['Open', 'High', 'Low', 'Close', 'Volume']]

price = df['Close'].iloc[-1]
prev_close = df['Close'].iloc[-25] if len(df) > 24 else df['Close'].iloc[0]
change_24h = ((price - prev_close) / prev_close) * 100

# --- VWAP (24h rolling) ---
tp = (df['High'] + df['Low'] + df['Close']) / 3
vwap = (tp * df['Volume']).rolling(24).sum() / df['Volume'].rolling(24).sum()
sq_diff = (tp - vwap) ** 2
std = np.sqrt(sq_diff.rolling(24).mean())
band_1u = vwap + std
band_1d = vwap - std
band_2u = vwap + 2 * std
band_2d = vwap - 2 * std

# --- CROP до начала VWAP ---
first_valid = vwap.first_valid_index()
df = df.loc[first_valid:].copy()
vwap = vwap.loc[first_valid:].copy()
band_1u = band_1u.loc[first_valid:].copy()
band_1d = band_1d.loc[first_valid:].copy()
band_2u = band_2u.loc[first_valid:].copy()
band_2d = band_2d.loc[first_valid:].copy()
price = df['Close'].iloc[-1]

# --- UO (уже считается на cropped данных) ---
def calc_uo(high, low, close, p1=7, p2=14, p3=28):
    prev_c = close.shift(1)
    bp = close - pd.concat([low, prev_c], axis=1).min(axis=1)
    tr = pd.concat([high, prev_c], axis=1).max(axis=1) - pd.concat([low, prev_c], axis=1).min(axis=1)
    a7 = bp.rolling(p1).sum() / tr.rolling(p1).sum()
    a14 = bp.rolling(p2).sum() / tr.rolling(p2).sum()
    a28 = bp.rolling(p3).sum() / tr.rolling(p3).sum()
    return 100 * ((4 * a7) + (2 * a14) + a28) / 7

uo = calc_uo(df['High'], df['Low'], df['Close'])

# --- CCI, RSI, WillR, CMF, MFI ---
def calc_rsi(close, period=14):
    delta = close.diff()
    gain = delta.where(delta > 0, 0).rolling(period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(period).mean()
    rs = gain / loss
    return 100 - (100 / (1 + rs))

def calc_cci(high, low, close, period=20):
    tp = (high + low + close) / 3
    sma = tp.rolling(period).mean()
    mad = tp.rolling(period).apply(lambda x: np.abs(x - x.mean()).mean(), raw=True)
    return (tp - sma) / (0.015 * mad)

def calc_willr(high, low, close, period=14):
    hh = high.rolling(period).max()
    ll = low.rolling(period).min()
    return -100 * (hh - close) / (hh - ll)

def calc_cmf(high, low, close, volume, period=20):
    mfm = ((close - low) - (high - close)) / (high - low)
    return (mfm * volume).rolling(period).sum() / volume.rolling(period).sum()

def calc_mfi(high, low, close, volume, period=14):
    tp = (high + low + close) / 3
    raw_money = tp * volume
    pos = raw_money.where(tp > tp.shift(1), 0)
    neg = raw_money.where(tp < tp.shift(1), 0)
    pos_sum = pos.rolling(period).sum()
    neg_sum = neg.rolling(period).sum()
    return 100 - (100 / (1 + pos_sum / neg_sum))

def calc_rsiatr(close, high, low, rsi_period=12, atr_period=12, rsi_ratio_period=24, q_window=600):
    # RSIATR: RSI / ATR% -> RSI, с динамическими уровнями
    # RSI
    delta = close.diff()
    gain = delta.where(delta > 0, 0).rolling(rsi_period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(rsi_period).mean()
    rs = gain / loss
    rsi = 100 - (100 / (1 + rs))
    # ATR
    prev_c = close.shift(1)
    tr = pd.concat([high - low, (high - prev_c).abs(), (low - prev_c).abs()], axis=1).max(axis=1)
    atr = tr.rolling(atr_period).mean()
    # ATR% + ratio
    atr_pct = atr / close
    ratio = rsi / atr_pct
    ratio_s = pd.Series(ratio)
    # RSI на ratio
    dr = ratio_s.diff()
    rg = dr.where(dr > 0, 0).rolling(rsi_ratio_period).mean()
    rl = (-dr.where(dr < 0, 0)).rolling(rsi_ratio_period).mean()
    r_r = rg / rl
    rsi_ratio = 100 - (100 / (1 + r_r))
    return rsi_ratio

rsi = calc_rsi(df['Close'])
cci = calc_cci(df['High'], df['Low'], df['Close'])
willr = calc_willr(df['High'], df['Low'], df['Close'])
cmf = calc_cmf(df['High'], df['Low'], df['Close'], df['Volume'])
mfi = calc_mfi(df['High'], df['Low'], df['Close'], df['Volume'])
rsiatr = calc_rsiatr(df['Close'], df['High'], df['Low'])

# --- WTMO ---
import sys
sys.path.insert(0, r'C:\Users\Cryptodatex\Desktop\santiment')
from wtmo import WTMOConfig, calculate_wtmo, get_wtmo_reversal_signal

wtmo_cfg = WTMOConfig(
    channel_length=12, average_length=24, signal_length=4,
    smoothing_type='HULL', smoothing_length=9, overbought=70, oversold=-70,
)
wtmo_df = calculate_wtmo(df['High'], df['Low'], df['Close'], config=wtmo_cfg)
wtmo_val = wtmo_df['wt1']
wtmo_sig_v = get_wtmo_reversal_signal(df['High'], df['Low'], df['Close'], config=wtmo_cfg)

# RSIATR сигнал
def calc_rsiatr_signal(series):
    tail = pd.Series(series).dropna()
    if len(tail) < 120:
        return 0, 50, 50, 0
    upper = float(tail.quantile(0.90))
    lower = float(tail.quantile(0.10))
    upper = min(max(upper, 60.0), 95.0)
    lower = max(min(lower, 40.0), 5.0)
    rr = series.iloc[-1] if hasattr(series, 'iloc') else series[-1]
    r1 = series.iloc[-2] if hasattr(series, 'iloc') else series[-2]
    r2 = series.iloc[-3] if hasattr(series, 'iloc') else series[-3]
    turning_down = (r2 > r1 > rr)
    turning_up = (r2 < r1 < rr)
    if rr >= upper and turning_down:
        return -1, upper, lower, rr
    if rr <= lower and turning_up:
        return 1, upper, lower, rr
    return 0, upper, lower, rr

rsiatr_sig, rsiatr_upper, rsiatr_lower, rsiatr_last = calc_rsiatr_signal(rsiatr)

# --- Текущие значения ---
rsi_v = rsi.iloc[-1]
cci_v = cci.iloc[-1]
willr_v = willr.iloc[-1]
uo_v = uo.iloc[-1]
cmf_v = cmf.iloc[-1]
mfi_v = mfi.iloc[-1]
rsiatr_v = rsiatr.iloc[-1]
wtmo_v = wtmo_val.iloc[-1]

# --- Цвета индикаторов ---
def color_val(val, high, low):
    if np.isnan(val):
        return '#999', False, False
    if val > high: return '#dc3545', False, True
    if val < low:  return '#28a745', True, False
    return '#333', False, False

c_cci,  g_cci,  r_cci  = color_val(cci_v, 150, -150)
c_rsi,  g_rsi,  r_rsi  = color_val(rsi_v, 75, 25)
c_willr,g_willr,r_willr= color_val(willr_v, -15, -85)
c_uo,   g_uo,   r_uo   = color_val(uo_v, 65, 35)
c_cmf,  g_cmf,  r_cmf  = color_val(cmf_v, 0.15, -0.15)
c_mfi,  g_mfi,  r_mfi  = color_val(mfi_v, 85, 15)
# RSIATR: динамические уровни через квантили
c_rsiatr = '#333'; g_rsiatr = False; r_rsiatr = False
if not np.isnan(rsiatr_v):
    if rsiatr_v >= rsiatr_upper: c_rsiatr = '#dc3545'; r_rsiatr = True
    elif rsiatr_v <= rsiatr_lower: c_rsiatr = '#28a745'; g_rsiatr = True
# WTMO
c_wtmo = '#333'; g_wtmo = False; r_wtmo = False
if not np.isnan(wtmo_v):
    if wtmo_v > 70: c_wtmo = '#dc3545'; r_wtmo = True
    elif wtmo_v < -70: c_wtmo = '#28a745'; g_wtmo = True
# WTMO сигнал в общий зачёт
if wtmo_sig_v == 1: g_wtmo = True
elif wtmo_sig_v == -1: r_wtmo = True

green_count = sum([g_cci, g_rsi, g_willr, g_uo, g_cmf, g_mfi, g_rsiatr, g_wtmo])
red_count = sum([r_cci, r_rsi, r_willr, r_uo, r_cmf, r_mfi, r_rsiatr, r_wtmo])

if green_count >= 3:
    signal_text = 'BUY'
    signal_color = '#28a745'
elif red_count >= 3:
    signal_text = 'SELL'
    signal_color = '#dc3545'
else:
    signal_text = 'NEUTRAL'
    signal_color = '#666'

# --- Cumulative Delta (из CSV) ---
df_raw = pd.read_csv(csv_path)
df_raw['Date'] = pd.to_datetime(df_raw['open_time_utc'])
df_raw = df_raw.sort_values('Date')
# Берём данные за тот же период
cutoff_raw = df_raw['Date'].max() - pd.Timedelta(days=PERIOD_DAYS)
df_raw = df_raw[df_raw['Date'] >= cutoff_raw].copy()
df_raw.set_index('Date', inplace=True)
# Вычисляем delta на сырых данных
delta_raw = 2 * df_raw['taker_buy_base_volume'] - df_raw['volume']
cum_delta_raw = delta_raw.cumsum()
# Обрезаем до начала VWAP (как и df)
cum_delta = cum_delta_raw.loc[first_valid:].copy()

# --- Addplots ---
ap_vwap = mpf.make_addplot(vwap, color='#1565c0', width=2.5, alpha=0.95)

uo_fill = mpf.make_addplot(uo, panel=1, color='#7c4dff', width=1.5, alpha=0.9, ylabel='UO')
uo_70 = mpf.make_addplot(pd.Series(70, index=uo.index), panel=1, color='#ff1744', width=0.8, alpha=0.4, linestyle='--')
uo_30 = mpf.make_addplot(pd.Series(30, index=uo.index), panel=1, color='#00c853', width=0.8, alpha=0.4, linestyle='--')
uo_50 = mpf.make_addplot(pd.Series(50, index=uo.index), panel=1, color='#999', width=0.6, alpha=0.4, linestyle='--')

ap_delta_line = mpf.make_addplot(cum_delta, panel=2, color='#333', width=1.5, alpha=0.8, ylabel='CumΔ', secondary_y=False)
ap_delta_zero = mpf.make_addplot(pd.Series(0, index=cum_delta.index), panel=2, color='#999', width=0.6, alpha=0.5)

addplots = [
    ap_vwap,
    uo_fill, uo_70, uo_30, uo_50,
    ap_delta_line, ap_delta_zero
]

fig, axes = mpf.plot(
    df,
    type='candle',
    volume=True,
    style='charles',
    addplot=addplots,
    figsize=(14, 8),
    returnfig=True,
    tight_layout=True,
    panel_ratios=(3, 1, 1),
    xrotation=20,
    scale_padding={'left': 0.5, 'top': 1.0, 'right': 0.5}
)

main_ax = axes[0]
x_idx = np.arange(len(df))

# --- VWAP bands — облака ---
main_ax.fill_between(x_idx, vwap.values, band_1u.values, alpha=0.25, color='#90caf9', zorder=0)
main_ax.fill_between(x_idx, band_1d.values, vwap.values, alpha=0.25, color='#90caf9', zorder=0)
main_ax.fill_between(x_idx, band_1u.values, band_2u.values, alpha=0.40, color='#42a5f5', zorder=0)
main_ax.fill_between(x_idx, band_2d.values, band_1d.values, alpha=0.40, color='#42a5f5', zorder=0)

# --- Границы bands ---
main_ax.plot(x_idx, band_2u.values, color='#1565c0', linewidth=0.8, linestyle='--', alpha=0.6, zorder=1)
main_ax.plot(x_idx, band_2d.values, color='#1565c0', linewidth=0.8, linestyle='--', alpha=0.6, zorder=1)
main_ax.plot(x_idx, band_1u.values, color='#0d47a1', linewidth=1.0, linestyle='--', alpha=0.7, zorder=1)
main_ax.plot(x_idx, band_1d.values, color='#0d47a1', linewidth=1.0, linestyle='--', alpha=0.7, zorder=1)

# --- Y lim ---
all_min = min(band_2d.min(), df['Low'].min())
all_max = max(band_2u.max(), df['High'].max())
pad = (all_max - all_min) * 0.08
main_ax.set_ylim(all_min - pad, all_max + pad)

# --- Price line ---
main_ax.axhline(y=price, color='#333', linewidth=0.6, linestyle='--', alpha=0.4)
main_ax.annotate(f'${price:,.0f}', xy=(len(df)-1, price),
                 xytext=(8, 0), textcoords='offset points', color='#333',
                 fontsize=11, fontweight='bold', va='center')

# --- Legend + индикаторы ---
from matplotlib.patches import Patch
legend_elements = [
    Patch(facecolor='#42a5f5', alpha=0.5, label='±2σ'),
    Patch(facecolor='#90caf9', alpha=0.4, label='±1σ'),
    plt.Line2D([0], [0], color='#1565c0', linewidth=2.5, label='VWAP')
]
leg = main_ax.legend(handles=legend_elements, loc='upper left', fontsize=8,
                     frameon=True, facecolor='white', framealpha=0.9, edgecolor='#ccc')

# --- Текст индикаторов под легендой ---
def fmt_val(v, dec=0):
    if np.isnan(v): return 'N/A'
    return f'{v:.{dec}f}'

def fmt_diff(v):
    d = v - price
    return f'({d:+.0f})'

# VWAP + bands со значениями
band_values = [
    ('+2σ',  fmt_val(band_2u.iloc[-1], 0), fmt_diff(band_2u.iloc[-1]), '#c62828'),
    ('+1σ',  fmt_val(band_1u.iloc[-1], 0), fmt_diff(band_1u.iloc[-1]), '#2e7d32'),
    ('VWAP', fmt_val(vwap.iloc[-1], 0), fmt_diff(vwap.iloc[-1]), '#1565c0'),
    ('-1σ',  fmt_val(band_1d.iloc[-1], 0), fmt_diff(band_1d.iloc[-1]), '#2e7d32'),
    ('-2σ',  fmt_val(band_2d.iloc[-1], 0), fmt_diff(band_2d.iloc[-1]), '#c62828'),
]

indicator_data = [
    ('CCI', fmt_val(cci_v, 0), c_cci),
    ('RSI', fmt_val(rsi_v, 1), c_rsi),
    ('WillR', fmt_val(willr_v, 1), c_willr),
    ('UO', fmt_val(uo_v, 1), c_uo),
    ('CMF', fmt_val(cmf_v, 2), c_cmf),
    ('MFI', fmt_val(mfi_v, 0), c_mfi),
    ('RSIATR', fmt_val(rsiatr_v, 1), c_rsiatr),
    ('WTMO', fmt_val(wtmo_v, 1), c_wtmo),
]

fig.canvas.draw()
leg_bbox = leg.get_window_extent().transformed(main_ax.transAxes.inverted())
x0 = leg_bbox.x0
y0 = leg_bbox.y0 - 0.005

# VWAP + bands строки
for i, (name, val, diff, color) in enumerate(band_values):
    main_ax.text(x0 + 0.01, y0 - 0.028 * i, f'{name}: ${val} {diff}',
                 transform=main_ax.transAxes, fontsize=7, fontfamily='monospace',
                 va='top', ha='left', color=color)

# Отступ + индикаторы
ind_start = y0 - 0.028 * (len(band_values) + 0.5)
for i, (name, val, color) in enumerate(indicator_data):
    main_ax.text(x0 + 0.01, ind_start - 0.028 * i, f'{name}: {val}',
                 transform=main_ax.transAxes, fontsize=7, fontfamily='monospace',
                 va='top', ha='left', color=color)

# Сигнал
sig_y = ind_start - 0.028 * (len(indicator_data) + 0.5)
main_ax.text(x0 + 0.01, sig_y, signal_text,
             transform=main_ax.transAxes, fontsize=9, fontweight='bold',
             va='top', ha='left', color=signal_color)

# --- Title ---
fig.suptitle(f'{SYMBOL} | ${price:,.0f} ({change_24h:+.2f}% 24h)',
             fontsize=14, fontweight='bold', x=0.5, y=0.98, color='#333')

fig.subplots_adjust(left=0.05, right=0.98, top=0.94, bottom=0.08, hspace=0.12)

# --- Save ---
output_path = r'C:\Users\Cryptodatex\Desktop\santiment\chart_btc_local.png'
fig.savefig(output_path, format='png', dpi=140, facecolor='white', bbox_inches='tight')
plt.close(fig)

print(f'Chart saved: {output_path}')
print(f'BTC: ${price:,.0f} | 24h: {change_24h:+.2f}%')
print(f'Indicators: CCI={cci_v:.0f} RSI={rsi_v:.1f} WillR={willr_v:.1f} UO={uo_v:.1f} CMF={cmf_v:.2f} MFI={mfi_v:.0f}')
print(f'Signal: {signal_text}')
