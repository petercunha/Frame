import { useRef, type PointerEvent, type ReactNode } from 'react';
import type { CropRegion } from '../../shared/types';

const full: CropRegion = { x: 0, y: 0, width: 1, height: 1 };
const clamp = (number: number, min: number, max: number) => Math.max(min, Math.min(max, number));

export default function CropSurface({ width, height, crop, aspect, onChange, children, disabled }: {
  width: number; height: number; crop?: CropRegion | null; aspect: number | null;
  onChange: (crop: CropRegion) => void; children: ReactNode; disabled?: boolean;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; crop: CropRegion; handle: string; pointerId: number } | null>(null);
  const region = crop ?? full;
  function begin(event: PointerEvent<HTMLElement>, handle: string) {
    if (disabled) return;
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, crop: region, handle, pointerId: event.pointerId };
  }
  function move(event: PointerEvent<HTMLElement>) {
    const start = drag.current;
    const rect = surface.current?.getBoundingClientRect();
    if (!start || !rect || start.pointerId !== event.pointerId) return;
    const dx = (event.clientX - start.x) / rect.width;
    const dy = (event.clientY - start.y) / rect.height;
    const box = start.crop;
    if (start.handle === 'move') return onChange({ ...box, x: clamp(box.x + dx, 0, 1 - box.width), y: clamp(box.y + dy, 0, 1 - box.height) });
    const west = start.handle.includes('w');
    const north = start.handle.includes('n');
    if (aspect) {
      const ratio = aspect / (width / height);
      const anchorX = west ? box.x + box.width : box.x;
      const anchorY = north ? box.y + box.height : box.y;
      const maxWidth = Math.min(west ? anchorX : 1 - anchorX, (north ? anchorY : 1 - anchorY) * ratio);
      const horizontal = west ? -dx : dx;
      const vertical = (north ? -dy : dy) * ratio;
      const target = box.width + (Math.abs(horizontal) > Math.abs(vertical) ? horizontal : vertical);
      const nextWidth = clamp(target, Math.min(0.02, maxWidth), maxWidth);
      const nextHeight = nextWidth / ratio;
      onChange({ x: west ? anchorX - nextWidth : anchorX, y: north ? anchorY - nextHeight : anchorY, width: nextWidth, height: nextHeight });
    } else {
      const left = west ? clamp(box.x + dx, 0, box.x + box.width - 0.01) : box.x;
      const top = north ? clamp(box.y + dy, 0, box.y + box.height - 0.01) : box.y;
      const right = west ? box.x + box.width : clamp(box.x + box.width + dx, box.x + 0.01, 1);
      const bottom = north ? box.y + box.height : clamp(box.y + box.height + dy, box.y + 0.01, 1);
      onChange({ x: left, y: top, width: right - left, height: bottom - top });
    }
  }
  return <div ref={surface} className="crop-surface" style={{ aspectRatio: `${width} / ${height}`, maxWidth: `min(100%, calc(var(--editor-preview-height) * ${width / height}))` }}>
    {children}
    <div className="crop-selection" role="group" aria-label="Crop area. Use arrow keys to move the crop." tabIndex={disabled ? -1 : 0}
      style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }}
      onPointerDown={event => begin(event, 'move')} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
      onKeyDown={event => {
        if (disabled || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const step = event.shiftKey ? 0.05 : 0.005;
        onChange({ ...region, x: clamp(region.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), 0, 1 - region.width), y: clamp(region.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0), 0, 1 - region.height) });
      }}>
      <span className="crop-grid" />
      {['nw', 'ne', 'sw', 'se'].map(handle => <button key={handle} type="button" disabled={disabled} className={`crop-handle crop-${handle}`} aria-label={`Resize crop ${handle}`} onPointerDown={event => begin(event, handle)} onPointerMove={move} onPointerUp={event => { event.stopPropagation(); drag.current = null; }} onPointerCancel={() => { drag.current = null; }} />)}
    </div>
  </div>;
}
