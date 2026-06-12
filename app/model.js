/**
 * Trading Dashboard - Model Layer
 * Bertanggung jawab atas: fetch data, parse, format, state management
 */

class TradingModel {
  constructor(options = {}) {
    this.config = {
      apiBase: options.apiBase || null,      // D1 API URL (null = use local file)
      localDataUrl: options.localDataUrl || 'data.json',
      refreshInterval: options.refreshInterval || 30000, // 30 detik
      retryAttempts: options.retryAttempts || 3,
      retryDelay: options.retryDelay || 2000,
    };
    
    // State
    this._state = {
      initial: 50.0,
      balance: 50.0,
      walletBalance: 50.0,
      equity: 50.0,
      unrealized_pnl: 0.0,
      margin_used: 0.0,
      available: 50.0,
      positions: [],
      history: [],
      cumRealisedPnl: 0,
      last_updated: '—',
      rawData: null,
    };
    
    this._listeners = [];
    this._refreshTimer = null;
    this._loading = false;
  }

  // ─── Getters (read-only access ke state) ─────────────────────────
  get initial()    { return this._state.initial; }
  get balance()    { return this._state.balance; }
  get equity()     { return this._state.equity; }
  get unrealizedPnl() { return this._state.unrealized_pnl; }
  get positions()  { return [...this._state.positions]; }
  get history()    { return [...this._state.history]; }
  get lastUpdated(){ return this._state.last_updated; }
  get isLoading()  { return this._loading; }
  get delta()      { return this._state.balance - this._state.initial; }
  get deltaPct()   { 
    const i = this._state.initial;
    return i > 0 ? (this.delta / i) * 100 : 0;
  }
  get totalTrades() { return this._state.history.length; }
  get openPositions() { 
    return this._state.positions.filter(p => p.status === 'open'); 
  }

  // ─── Data Fetching ────────────────────────────────────────────────
  async fetchData() {
    this._setLoading(true);
    let lastError;
    
    for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
      try {
        const url = this.config.apiBase 
          ? `${this.config.apiBase}/combined`
          : `${this.config.localDataUrl}?v=${Date.now()}`;
        
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        
        const data = await resp.json();
        this._updateState(data);
        this._setLoading(false);
        this._notify('data:updated', this._state);
        return this._state;
        
      } catch (err) {
        lastError = err;
        if (attempt < this.config.retryAttempts) {
          await this._sleep(this.config.retryDelay * attempt);
        }
      }
    }
    
    this._setLoading(false);
    this._notify('data:error', lastError);
    throw lastError;
  }

  // ─── State Management ─────────────────────────────────────────────
  _updateState(data) {
    // Gabungkan history: open positions + closed trades (sorted newest first)
    const openPositions = (data.positions || []).map(p => this._normalizePosition(p));
    const closedTrades  = (data.history  || []).filter(h => h.status === 'closed' || h.close_time);
    
    // Ambil closed trades dari history
    const closed = closedTrades.map(h => this._normalizeHistory(h));
    
    // Unique symbols: open positions override closed trades
    const closedSymbols = new Set(closed.map(h => h.symbol));
    const openAsHistory = openPositions.filter(p => !closedSymbols.has(p.symbol));
    
    const combined = [...openAsHistory, ...closed].sort((a, b) => {
      const timeA = new Date(a.close_time || a.open_time);
      const timeB = new Date(b.close_time || b.open_time);
      return timeB - timeA; // newest first
    });

    this._state = {
      initial:        parseFloat(data.initial)        || 50.0,
      balance:        parseFloat(data.balance)         || 50.0,
      walletBalance:  parseFloat(data.walletBalance)   || parseFloat(data.wallet_balance) || 50.0,
      equity:         parseFloat(data.equity)          || 50.0,
      unrealized_pnl: parseFloat(data.unrealized_pnl)  || 0.0,
      margin_used:    parseFloat(data.margin_used)     || 0.0,
      available:      parseFloat(data.available)       || 50.0,
      positions:      openPositions,
      history:        combined,
      cumRealisedPnl: parseFloat(data.cumRealisedPnl)  || 0.0,
      last_updated:   data.last_updated                || this._state.last_updated,
      rawData:        data,
    };
  }

  _normalizePosition(p) {
    return {
      symbol:       p.symbol      || p.symbol,
      direction:    p.side        || 'LONG',
      size:         parseFloat(p.size)         || 0,
      entry:        parseFloat(p.avgPrice)     || parseFloat(p.entry_price)  || 0,
      markPrice:    parseFloat(p.markPrice)    || parseFloat(p.mark_price)   || 0,
      unrealizedPnl:parseFloat(p.unrealizedPnl)|| parseFloat(p.unrealized_pnl)|| 0,
      leverage:     parseInt(p.leverage)       || 1,
      sl:           parseFloat(p.sl)           || parseFloat(p.stop_loss)   || null,
      tp:           parseFloat(p.tp)           || parseFloat(p.take_profit) || null,
      open_time:    p.open_time                || this._nowWIB(),
      close_time:   null,
      pnl:          parseFloat(p.unrealizedPnl)|| parseFloat(p.unrealized_pnl)|| 0,
      status:       'open',
      note:         p.note || 'unrealized PnL',
    };
  }

  _normalizeHistory(h) {
    return {
      symbol:     h.symbol     || h.symbol,
      direction:  h.direction  || h.side   || h.direction,
      size:       parseFloat(h.size)       || 0,
      entry:      parseFloat(h.entry)      || parseFloat(h.entry_price)   || 0,
      exit:       parseFloat(h.exit)       || parseFloat(h.exit_price)    || null,
      pnl:        parseFloat(h.pnl)        || 0,
      open_time:  h.open_time              || this._nowWIB(),
      close_time: h.close_time             || null,
      status:     h.status                 || 'closed',
      note:       h.note                   || '',
    };
  }

  _nowWIB() {
    const now = new Date();
    const wib = new Date(now.getTime() + 7 * 3600 * 1000);
    return wib.toISOString().replace('Z', '+07:00');
  }

  // ─── Formatters ───────────────────────────────────────────────────
  fmtCurrency(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    const sign = n >= 0 ? '' : '−';
    const absVal = Math.abs(n);
    if (absVal < 0.000001) return '$0.00';
    return sign + '$' + absVal.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  fmtDecimal(n, decimals = 2) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    return Number(n).toFixed(decimals) + '%';
  }

  fmtDate(ts) {
    if (!ts) return '—';
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return ts;
      return d.toLocaleDateString('id-ID', {
        year: 'numeric', month: 'short', day: 'numeric',
      });
    } catch { return ts; }
  }

  fmtTime(ts) {
    if (!ts) return '—';
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return ts;
      return d.toLocaleTimeString('id-ID', {
        hour: '2-digit', minute: '2-digit',
      }) + ' WIB';
    } catch { return ts; }
  }

  fmtDateTime(ts) {
    if (!ts) return '—';
    try {
      const d = new Date(ts);
      if (isNaN(d.getTime())) return ts;
      return d.toLocaleDateString('id-ID', {
        year: 'numeric', month: 'short', day: 'numeric',
      }) + '<br><small>' + d.toLocaleTimeString('id-ID', {
        hour: '2-digit', minute: '2-digit',
      }) + ' WIB</small>';
    } catch { return ts; }
  }

  fmtPrice(p) {
    if (p === null || p === undefined) return '—';
    const v = Number(p);
    if (v < 0.0001) return v.toFixed(8);
    if (v < 0.01)   return v.toFixed(6);
    if (v < 1)      return v.toFixed(4);
    return v.toFixed(2);
  }

  // ─── Pub/Sub ( Observer Pattern) ─────────────────────────────────
  on(event, callback) {
    this._listeners.push({ event, callback });
  }

  off(event, callback) {
    this._listeners = this._listeners.filter(
      l => !(l.event === event && (!callback || l.callback === callback))
    );
  }

  _notify(event, data) {
    this._listeners
      .filter(l => l.event === event)
      .forEach(l => { try { l.callback(data); } catch(e) { console.error(e); } });
  }

  // ─── Lifecycle ────────────────────────────────────────────────────
  startAutoRefresh() {
    this.stopAutoRefresh();
    this._refreshTimer = setInterval(() => this.fetchData(), this.config.refreshInterval);
  }

  stopAutoRefresh() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
  }

  _setLoading(v) {
    this._loading = v;
    this._notify('loading:changed', v);
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

// Export untuk ES module
export { TradingModel };
export default TradingModel;