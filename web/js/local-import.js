/**
 * Local KML / KMZ / GPX / GeoJSON Import & Drag-Drop Handling
 */
import { LOCAL_ROUTE_PALETTE, state, showToast, actions } from './app-state.js';
import { parseLocalRouteFile } from './local-kml-parser.js';
import {
  clearCategorySelectedLayers,
  hidePreviewCard,
  renderCategoryList,
  renderCategoryOverviewOnMap,
  selectLocalRoute
} from './page-category.js';

export function removeLocalRoute(localId) {
  const idx = state.localRoutes.findIndex((r) => r.id === localId);
  if (idx < 0) return;
  state.localRoutes.splice(idx, 1);
  if (state.selectedMode === 'local' && state.selectedLocalId === localId) {
    clearCategorySelectedLayers();
    hidePreviewCard();
    state.selectedMode = null;
    state.selectedLocalId = null;
    state.currentEntry = null;
    state.currentGeojson = null;
    state.currentQc = null;
  }
  actions.renderCounts?.();
  renderCategoryList();
  renderCategoryOverviewOnMap(false);
}

export function clearLocalRoutes() {
  state.localRoutes = [];
  if (state.selectedMode === 'local') {
    clearCategorySelectedLayers();
    hidePreviewCard();
    state.selectedMode = null;
    state.selectedLocalId = null;
    state.currentEntry = null;
    state.currentGeojson = null;
    state.currentQc = null;
  }
  actions.renderCounts?.();
  renderCategoryList();
  renderCategoryOverviewOnMap(false);
  showToast('已清空本地预览列表');
}

export async function handleLocalFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const imported = [];
  const errors = [];

  for (const file of files) {
    try {
      const { entry, geojson } = await parseLocalRouteFile(file, state.schema);
      const id = `local__${file.name}__${file.size}`;
      const existingIdx = state.localRoutes.findIndex((r) => r.id === id);
      const color = existingIdx >= 0
        ? state.localRoutes[existingIdx].color
        : LOCAL_ROUTE_PALETTE[state.localRoutes.length % LOCAL_ROUTE_PALETTE.length];
      entry._color = color;
      const item = { id, color, entry, geojson };
      if (existingIdx >= 0) state.localRoutes[existingIdx] = item;
      else state.localRoutes.unshift(item);
      imported.push(item);
    } catch (err) {
      errors.push(`${file.name}: ${err.message}`);
    }
  }

  if (imported.length) {
    actions.renderCounts?.();
    actions.openCategoryPage?.('local', { resetFilters: false, fitRoutes: false });
    selectLocalRoute(imported[0].id, imported.length === 1);
    if (imported.length > 1) {
      await renderCategoryOverviewOnMap(true);
    }
    showToast(errors.length
      ? `已导入 ${imported.length} 个文件，${errors.length} 个失败`
      : `已导入本地路线：${imported[0].entry.name}`);
  } else if (errors.length) {
    showToast(errors[0]);
  }
}

export function setupDragAndDrop() {
  const dropOverlay = document.getElementById('drop-overlay');
  let dragDepth = 0;
  const isFileDrag = (e) => Boolean(e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files'));
  const hideOverlay = () => {
    dragDepth = 0;
    dropOverlay?.classList.remove('active');
  };
  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth += 1;
    dropOverlay?.classList.add('active');
  });
  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
  });
  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay?.classList.remove('active');
  });
  window.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    hideOverlay();
    if (e.dataTransfer?.files?.length) handleLocalFiles(e.dataTransfer.files);
  });
  window.addEventListener('blur', hideOverlay);
}

export function bindLocalImportEvents() {
  document.getElementById('btn-open-local-kml')?.addEventListener('click', () => {
    document.getElementById('local-kml-input')?.click();
  });
  document.getElementById('local-kml-input')?.addEventListener('change', (e) => {
    if (e.target.files?.length) {
      handleLocalFiles(e.target.files);
      e.target.value = '';
    }
  });
  setupDragAndDrop();
}
