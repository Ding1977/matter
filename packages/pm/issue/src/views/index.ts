/**
 * 视图配置模块（P4 V 轨数据半）：ViewConfig schema + views.json Store。
 * @module @matter/issue/src/views
 */

export {
  FILTER_LOGICS, FILTER_OPS, SORT_DIRS, VIEW_TYPES,
  FilterCondition, FilterGroup, GroupRule, SortRule, ViewConfig, ViewConfigList, ViewField,
  minimalView,
} from "./spec.ts"
export type { ViewConfig as ViewConfigT, ViewConfigList as ViewConfigListT } from "./spec.ts"
export {
  DEFAULT_DEBOUNCE_MS, VIEWS_DESCRIPTOR, ViewConfigStore, ViewStoreClosedError,
} from "./store.ts"
export type { ViewsStoreOptions } from "./store.ts"
