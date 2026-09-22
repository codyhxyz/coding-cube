// herdr decorates the first nine workspaces and the first nine tabs of each with the
// number that switches to them — "Face 1" is reported as "[1] Face 1" — and leaves the
// tenth onward undecorated. Measured against herdr 0.8.2: `tab create --label "Face 1"`
// stores "Face 1" and `api snapshot` reports "[1] Face 1" beside `number: 1`.
//
// That prefix is a keyboard hint, not the name anybody gave the thing. Strip it before
// matching a name or showing one, and strip it only when it is the item's OWN number, so
// a tab a human really did call "[3] notes" keeps the name they chose.
export function plainLabel(item) {
  const label = item?.label ?? '';
  const prefix = `[${item?.number}] `;
  return label.startsWith(prefix) ? label.slice(prefix.length) : label;
}

export function herdrMetadata(envelope = {}) {
  const snapshot = envelope.result?.snapshot || {};
  const workspace = focused(snapshot.workspaces, snapshot.focused_workspace_id, 'workspace_id');
  const tab = focused(snapshot.tabs, snapshot.focused_tab_id || workspace?.active_tab_id, 'tab_id');
  const pane = focused(snapshot.panes, snapshot.focused_pane_id, 'pane_id');

  return {
    label: plainLabel(tab) || plainLabel(workspace) || 'Unlabeled session',
    status: pane?.agent_status || tab?.agent_status || workspace?.agent_status || 'unknown',
  };
}

function focused(items, id, key) {
  return items?.find((item) => item[key] === id) || items?.find((item) => item.focused);
}
