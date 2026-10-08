import { EDGE_DEFAULT_SERVER_HOST, EDGE_DEFAULT_SERVER_PORT } from '../edgeMode.js';
import { useI18n } from '../i18n.js';

export type EdgeServerFieldsValue = {
  /** 服务器地址：可以只填 IP，也可以填完整 https://域名。 */
  address: string;
  /** 端口，留空表示用协议默认端口。 */
  port: string;
};

type EdgeServerFieldsProps = {
  value: EdgeServerFieldsValue;
  onChange: (patch: Partial<EdgeServerFieldsValue>) => void;
  disabled?: boolean;
  idPrefix?: string;
};

/**
 * 「服务器地址 + 端口」输入区，登录页与同步设置弹窗共用。
 * 只收集输入，不做任何地址拼接：协议与规整由服务端统一处理，避免两边各写一套。
 */
export default function EdgeServerFields({
  value,
  onChange,
  disabled = false,
  idPrefix = 'edge-server',
}: EdgeServerFieldsProps) {
  const { t } = useI18n();
  const addressId = `${idPrefix}-address`;
  const portId = `${idPrefix}-port`;

  return (
    <div className="edge-server-fields">
      <div className="edge-server-row">
        <div className="edge-server-field">
          <label className="edge-server-label" htmlFor={addressId}>{t('服务器地址')}</label>
          <input
            id={addressId}
            className="edge-server-input"
            placeholder={EDGE_DEFAULT_SERVER_HOST}
            value={value.address}
            disabled={disabled}
            onChange={(event) => onChange({ address: event.target.value })}
          />
        </div>
        <div className="edge-server-field edge-server-field-narrow">
          <label className="edge-server-label" htmlFor={portId}>{t('端口')}</label>
          <input
            id={portId}
            className="edge-server-input"
            placeholder={EDGE_DEFAULT_SERVER_PORT}
            inputMode="numeric"
            value={value.port}
            disabled={disabled}
            onChange={(event) => onChange({ port: event.target.value.replace(/[^\d]/g, '') })}
          />
        </div>
      </div>
      <div className="edge-server-hint">
        {t('只支持 HTTPS 时请在地址里写完整域名（https://域名），端口留空即用默认端口。')}
      </div>
    </div>
  );
}
