export type ModelForwardTargetRow = {
  id: number;
  ruleId: number;
  siteId: number;
  siteName: string | null;
  accountId: number;
  accountUsername: string | null;
  accountStatus: string | null;
  tokenId: number | null;
  tokenName: string | null;
  upstreamModel: string;
  channelId: number | null;
  weight: number;
  enabled: boolean;
  sortOrder: number;
  channelEnabled: boolean | null;
  cooldownUntil: string | null;
  successCount: number | null;
  failCount: number | null;
  /** 连续上游失败达到阈值后被自动降级到最低优先级；成功一次即恢复。 */
  autoDemotedAt: string | null;
  consecutiveUpstreamFailures: number | null;
  lastUsedAt: string | null;
};

export type ModelForwardRuleRow = {
  id: number;
  modelName: string;
  enabled: boolean;
  notes: string | null;
  routeId: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  targets: ModelForwardTargetRow[];
};

export type ModelForwardSiteOption = {
  id: number;
  name: string;
  url: string;
  status: string;
};

export type ModelForwardAccountOption = {
  id: number;
  siteId: number;
  username: string | null;
  status: string;
  tokenId: number | null;
  tokenName: string | null;
};

export type ModelForwardOptions = {
  sites: ModelForwardSiteOption[];
  accounts: ModelForwardAccountOption[];
  models: string[];
};

/** 弹窗里的一行「站点 + 上游模型 + 多账号」。 */
export type ModelForwardDraftTarget = {
  siteId: number | null;
  upstreamModel: string;
  accountIds: number[];
};
