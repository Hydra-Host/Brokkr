import type { InitTask } from '@/contract';
import { initAggregateState, initFocusTask, initTaskDone } from '@/contract';

import { healthUi } from './health-ui';
import { SummaryRow } from './summary-row';

export const INIT_STATE_HINT: Record<InitTask['state'], string> = {
  pending: 'did not run this bring-up and has no earlier success on disk',
  cached: 'skipped this bring-up by its status predicate — the last run exited 0',
  running: 'the log is still growing and no exit status has landed',
  completed: 'exited 0 during this bring-up',
  failed: 'exited non-zero during this bring-up',
};

const stateNote = (task: InitTask): string => {
  const { note } = healthUi(task.state);
  return task.state === 'failed' ? `${note} exit ${task.exitCode ?? '?'}` : note;
};

/** A one-line row shows the label, so the raw name rides the tooltip — it is what an operator types
 *  to re-run the task, and the collapsed summary only ever names the focus task. */
const rowTitle = (task: InitTask): string => `${task.name} — ${INIT_STATE_HINT[task.state]}`;

export function initSummary(tasks: InitTask[]): string {
  const focus = initFocusTask(tasks);
  const done = tasks.filter(initTaskDone).length;
  if (focus) return `${focus.name} ${stateNote(focus)} · ${done}/${tasks.length}`;
  return done === tasks.length ? `${done} completed` : `${done}/${tasks.length} completed`;
}

/** One rail row that carries its own state, so a failure needs no banner and no expanding to see.
 *  Sits high in the rail permanently — conditional placement would be its own kind of jumping. */
export function InitDagStrip({
  tasks,
  activeName,
  open,
  onToggle,
  onView,
}: {
  tasks: InitTask[];
  activeName?: string;
  open: boolean;
  onToggle: () => void;
  onView: (name: string) => void;
}) {
  const focus = initFocusTask(tasks);
  const aggregate = initAggregateState(tasks);
  const ui = healthUi(aggregate);
  return (
    <div>
      <SummaryRow
        lead={open ? '⌄' : '›'}
        ui={ui}
        label="Init DAG"
        detail={initSummary(tasks)}
        title={INIT_STATE_HINT[aggregate]}
        expanded={open}
        onClick={onToggle}
        action={
          focus && (
            <button
              onClick={() => onView(focus.name)}
              className="text-text-muted hover:bg-hover-bg shrink-0 rounded px-1.5 py-0.5 text-[10px]"
            >
              log
            </button>
          )
        }
      />
      {open && (
        <div className="mt-1 pl-4">
          {tasks.map((task) => (
            <InitTaskRow
              key={task.name}
              task={task}
              active={task.name === activeName}
              onView={() => onView(task.name)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The row is the log button — an init task has no controls to put beside one. */
function InitTaskRow({ task, active, onView }: { task: InitTask; active: boolean; onView: () => void }) {
  const ui = healthUi(task.state);
  return (
    <button
      onClick={onView}
      title={rowTitle(task)}
      className={[
        'flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[11px]',
        active ? 'bg-accent/10' : 'hover:bg-hover-bg',
      ].join(' ')}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${ui.dot}`} />
      <span className={`truncate ${active ? 'text-accent' : 'text-text-muted'}`}>{task.label}</span>
      <span className={`ml-auto shrink-0 ${ui.text}`} title={task.detail ?? undefined}>
        {stateNote(task)}
      </span>
    </button>
  );
}
