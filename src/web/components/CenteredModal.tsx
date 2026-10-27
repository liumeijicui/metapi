import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAnimatedVisibility } from './useAnimatedVisibility.js';

type CenteredModalProps = {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: number;
  /**
   * 显式宽度。`.modal-content` 默认是 `min(90vw, 500px)`，只给 maxWidth 是撑不开的；
   * 需要更宽的弹窗（例如批量测试的两栏布局）用这个字段。
   */
  width?: number;
  bodyStyle?: React.CSSProperties;
  closeOnBackdrop?: boolean;
  closeOnEscape?: boolean;
  showCloseButton?: boolean;
};

export default function CenteredModal({
  open,
  onClose,
  title,
  children,
  footer,
  maxWidth = 860,
  width,
  bodyStyle,
  closeOnBackdrop = false,
  closeOnEscape = false,
  showCloseButton = true,
}: CenteredModalProps) {
  const presence = useAnimatedVisibility(open, 220);
  const canUsePortal = typeof document !== 'undefined'
    && !!document.body
    && typeof document.body.appendChild === 'function'
    && typeof document.body.removeChild === 'function';

  useEffect(() => {
    if (!open || !canUsePortal) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [canUsePortal, open]);

  useEffect(() => {
    if (!open || !closeOnEscape || !canUsePortal) return;
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeydown);
    return () => {
      document.removeEventListener('keydown', handleKeydown);
    };
  }, [canUsePortal, closeOnEscape, open, onClose]);

  if (!presence.shouldRender) return null;

  const modal = (
    <div
      className={`modal-backdrop ${presence.isVisible ? '' : 'is-closing'}`.trim()}
      onClick={closeOnBackdrop ? onClose : undefined}
    >
      <div
        className={`modal-content ${presence.isVisible ? '' : 'is-closing'}`.trim()}
        style={{
          maxWidth,
          ...(width ? { width: `min(${width}px, calc(100vw - 32px))` } : {}),
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          {showCloseButton ? (
            <button
              type="button"
              className="modal-close-button"
              onClick={onClose}
              aria-label="关闭弹框"
            >
              ×
            </button>
          ) : null}
        </div>
        <div className="modal-body" style={bodyStyle}>
          {children}
        </div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );

  return canUsePortal ? createPortal(modal, document.body) : modal;
}
