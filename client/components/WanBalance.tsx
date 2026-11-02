import { LoaderCircle, RefreshCw, Wallet } from 'lucide-react';
import type { WanBalanceState } from '../wan-balance';
import './wan-balance.css';

const dollars = (value: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: Math.abs(value) > 0 && Math.abs(value) < 0.01 ? 6 : 2 }).format(value);

export default function WanBalance({ state, connected, onConnect }: { state: WanBalanceState; connected: boolean; onConnect?: () => void }) {
  const { data, loading, error, refresh } = state;
  return <section className="wan-balance" aria-label="Wan account balance" aria-busy={loading}>
    <div className="wan-balance-heading"><span><Wallet size={15} /> Wan account</span>{connected && <button className="text-button" aria-label="Refresh Wan balance" disabled={loading} onClick={() => void refresh()}>{loading ? <LoaderCircle size={12} className="spin" /> : <RefreshCw size={12} />} Refresh</button>}</div>
    {!connected ? <div className="wan-balance-empty"><p>Connect Wan API to see your account balance.</p>{onConnect && <button className="text-button" onClick={onConnect}>Connect Wan API</button>}</div> : <>
      {data ? <><dl className="wan-balance-values"><div><dt>Account balance</dt><dd>{dollars(data.balance)} <small>USD</small></dd></div>{data.keyRemaining !== null && <div><dt>Available with this key</dt><dd>{dollars(Math.max(0, Math.min(data.balance, data.keyRemaining)))} <small>USD</small></dd></div>}</dl><div className="wan-balance-caption"><span>{data.keyRemaining === null ? 'No API key spending limit' : `Key limit remaining: ${dollars(data.keyRemaining)}`}</span><time dateTime={data.checkedAt}>Updated {new Date(data.checkedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time></div></> : !error && <p className="wan-balance-loading" role="status">{loading ? 'Checking your balance…' : 'Balance is not available yet.'}</p>}
      {error && <p className="wan-balance-error" role="alert">{error}</p>}
    </>}
  </section>;
}
