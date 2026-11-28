export * from './types.js';
export { computeHealthScore } from './health.js';
export { computeInfluxSizing, SIZING_CONSTANTS } from './influx-sizing.js';
export type { InfluxSizingInput, InfluxSizingResult } from './influx-sizing.js';
export { deriveQuorumState, deriveQdeviceState, qdeviceStateFromCorosync } from './quorum.js';
export { computePra } from './pra.js';
export { linearRegression, buildForecast } from './capacity.js';
export type { RegressionResult } from './capacity.js';
export {
  THIN_STORAGE_TYPES,
  isThinStorage,
  DEFAULT_OVERCOMMIT_CONFIG,
  overcommitTone,
  usageSeverity,
  computeOvercommit,
  riskSeverity,
} from './overcommit.js';
export type { OvercommitMetric, OvercommitReport } from './overcommit.js';
export {
  AUDIT_PENALTIES,
  DEFAULT_AUDIT_CONFIG,
  CHECKS_META,
  auditLabelKey,
  runAudit,
  checkQemuWithoutAgent,
  checkPrivilegedContainers,
  checkCpuHostType,
  checkBridgeWithoutPorts,
  checkThinPoolOverprovisioning,
  checkMemoryOvercommit,
  checkNodeVersionMismatch,
  checkAutostart,
  checkStuckSnapshots,
  checkReplicationState,
  checkBondMembers,
  checkZfsArcMax,
  checkDiskErrors,
  checkDiskServiceLife,
  checkFailedUnits,
  checkPendingReboot,
  checkSecurityUpdates,
} from './audit.js';
export type {
  AuditSeverity,
  AuditTargetKind,
  AuditTarget,
  AuditFinding,
  AuditCounts,
  AuditScore,
  AuditBridge,
  AuditBond,
  AuditReplication,
  AuditZfsArc,
  AuditSmartDisk,
  AuditFailedUnit,
  AuditRebootPending,
  AuditSecurityUpdates,
  AuditInput,
  AuditConfig,
  AuditCheckMeta,
  AuditEndpointResult,
  AuditAllResponse,
} from './audit.js';
export { subnetOf, parseVmNets, buildTopology, segmentKey, impactAnalysis, ipInSubnet, internalNetworkSegments, matchAgentNetsByMac, primaryAgentIp } from './network.js';
export type { NetworkKind } from './network.js';
export { segmentImpact, buildNetworkInventory, buildNetworkInventoryAll, filterNetworkRows, encodeNetSel, decodeNetSel } from './network-inventory.js';
export type { NetworkRow, NetworkRowAll, NetworkVmRef, NetworkSeverity, InventoryFilter } from './network-inventory.js';
export { buildStorageInventory, buildStorageInventoryAll, filterStorageRows, storageSeverity, sortStorageRows, buildDatastoreForecast } from './storage-inventory.js';
export { buildStorageVolumes } from './storage-volumes.js';
export type { StorageVolumesResult, LunSizes } from './storage-volumes.js';
export type { StorageRow, StorageRowAll, StorageVmRef, StorageKind, StorageInventoryFilter, StorageInventoryEndpoint, StorageInventoryResponse, StorageSortKey, StorageSortDir, StorageSort, DatastorePoint, DatastoreHistoryEntry, DatastoreHistoryResponse, DatastoreRange } from './storage-inventory.js';
export { buildVmTree, DEFAULT_VM_FILTER, filterVmRows, sortVmRows } from './vm-view.js';
export type { VmTreeNode, VmViewFilter, VmSortKey, VmSortDir } from './vm-view.js';
export { DEFAULT_INV_FILTER, filterInvRows, sortInvRows, invSummary, invTotalDiskMb, fmtSize, invToTxt, invToCsv, invToJson, invToFormat, osFamilyFromId, ostypeFamily, osPrettyFromOstype, osDisplay, archLabel } from './proxmox-inventory.js';
export type { InvDisk, InvInterface, InvVm, ProxmoxInventoryEndpoint, ProxmoxInventoryResponse, InvFilter, InvSortKey, InvSortDir, InvSummary } from './proxmox-inventory.js';
export {
  authorizedModuleIds,
  authorizedModuleEntries,
  computeVisibleVersionIds,
  computeVisibleModuleIds,
  isAuthorizedModuleSelection,
  toPublicUser,
  validatePassword,
  DEFAULT_MODULES,
} from './auth.js';
export type {
  Role,
  ProviderId,
  User,
  Group,
  ModuleDef,
  UserGroup,
  UserModule,
  GroupModule,
  AuthFile,
  PublicUser,
  AuthPayload,
  PasswordIssue,
} from './auth.js';
export { PLUGIN_ID_RE, parsePluginVersion, defaultPluginVersion, groupPluginFamilies } from './module-versions.js';
export type { PluginVersionRef } from './module-versions.js';
export { ADMIN_AUDIT_ACTIONS, pageAuditEntries } from './admin-audit.js';
export type { AdminAuditActor, AdminAuditAction, AdminAuditEntry, AdminAuditPage, AdminAuditPageOptions } from './admin-audit.js';
export { mergeBackupBundle, parseBackupBundle } from './admin-backup.js';
export type { BackupBundle, BackupMergeOptions, BackupMergeResult, BackupMergeStats } from './admin-backup.js';
export {
  METRIC_IDS,
  NSCA_OK,
  NSCA_WARNING,
  NSCA_CRITICAL,
  NSCA_UNKNOWN,
  nscaReturnCode,
  escapeNscaField,
  buildNscaFrame,
  buildNscaHostFrame,
  renderOutput,
  defaultServiceName,
  suggestCenteronHost,
  conditionMet,
  evaluateAlarm,
  evaluateAlarmHysteresis,
  nscaCfgContent,
  shellQuote,
  clapiProvisionCommands,
  clapiDeleteCommand,
  clapiDeleteCommands,
  DEFAULT_POLLERS,
  defaultCenteronConfig,
  SENSOR_METRICS,
  isSensorMetric,
  sensorTargetFields,
  sensorMetricValue,
  resolveSensorThresholds,
} from './centreon-nsca.js';
export type {
  AlarmSeverity,
  AlarmOperator,
  TargetKind,
  AlarmTarget,
  MetricId,
  CentreonPoller,
  NscaConfig,
  ProvisionTransport,
  ClapiMode,
  CentreonConfig,
  VmMapping,
  ProvisionStatus,
  NscaSendState,
  AlarmRule,
  CentreonNscaFile,
  AlarmStats,
  MetricSample,
  AlarmEvalResult,
  AlarmHysteresisResult,
} from './centreon-nsca.js';
export type {
  NodeNic,
  NodeBridge,
  NodeBond,
  ParsedVmNet,
  VmAgentNetIf,
  NetworkSegment,
  TopologySwitch,
  TopologyNode,
  TopologyVm,
  NetworkTopology,
  NetworkFailure,
  ImpactResult,
} from './network.js';
export { resources, DEFAULT_LANG } from './i18n/index.js';
export type { Lang } from './i18n/index.js';
export {
  USER_CONFIG_SCHEMA_VERSION,
  USER_CONFIG_GRID_COLS,
  MAX_LAYOUT_ITEMS,
  MAX_LIBRARY_ITEMS,
  MAX_WIDGET_ID_LEN,
  MAX_SCOPE_LEN,
  MAX_Y,
  MAX_H,
  clampWidgetItem,
  defaultStackLayout,
  mergePageConfig,
  removeWidget,
  addWidget,
  getScopePage,
  setScopePage,
  clearScopePage,
  parseUserConfig,
} from './user-config.js';
export type { UserConfigPage, WidgetItem, PageConfig, UserConfig, WidgetDef } from './user-config.js';
export type { SmartDevice, SensorReading, ZfsStatus, FailedUnit, NodeSensorsResponse, SensorAlarmData, SensorThresholds, SensorThresholdEntry, SensorThresholdsResponse, SensorHistoryPoint, SensorHistoryResponse, SmartHistoryResponse } from './node-sensors.js';
export { sensorKey, effectiveSensorThreshold, tempTone, smartHealthTone, smartTempDisplay } from './node-sensors.js';
export type { NodeCpuCore, NodeSystemRow, NodeSystemResponse, NodeHardwareRow, NodeHardwareResponse, NodeDiskioRow, NodeDiskioResponse, VmDiskioPoint, VmDiskioSeries, VmDiskioResponse, PveMapperParse, NodeNetRow, NodeNetResponse, NodeNetIface, NodeNetFwInfo, VmNetPoint, VmNetSeries, VmNetResponse, NodeTempPoint, NodeTempSeries, NodeTempsResponse, SmartTempPoint, SmartTempSeries, SmartTempsResponse, ZfsArcPoint, ZfsArcResponse, NodeHostHistoryPoint, NodeHostHistoryResponse } from './system-metrics.js';
export { parsePveMapperName, mapperLabel, isPhysicalDevice, zfsHitRatePct, swapPct } from './system-metrics.js';
