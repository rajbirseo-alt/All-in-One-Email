import type { MergePreview } from '@crm/shared';

/** What a merge will do, shown before anything changes. */
export function MergePreviewView({ preview }: { preview: MergePreview }) {
  const m = preview.moves;
  const keep = preview.target.name ?? preview.target.primaryEmail;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-2 p-3 text-[13.5px]">
      <p>
        <strong>{keep}</strong> stays. Moving to it: {m.emails} email address{m.emails === 1 ? '' : 'es'}, {m.threads} conversation{m.threads === 1 ? '' : 's'}, {m.leads} lead{m.leads === 1 ? '' : 's'}, {m.tasks} task{m.tasks === 1 ? '' : 's'}
        {m.tags ? `, ${m.tags} tag${m.tags === 1 ? '' : 's'}` : ''}.
      </p>
      {preview.fills.length > 0 && (
        <div>
          <p className="font-medium">Filled in from the merged contact</p>
          <ul className="list-disc pl-5 text-text-2">
            {preview.fills.map((f, i) => (
              <li key={i}>
                {f.field}: {f.value}
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview.conflicts.length > 0 && (
        <div>
          <p className="font-medium">Different values: {keep}’s are kept</p>
          <ul className="list-disc pl-5 text-text-2">
            {preview.conflicts.map((c, i) => (
              <li key={i}>
                {c.field}: keeps “{c.kept}”, drops “{c.dropped}”
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-[12.5px] text-text-3">Nothing is deleted. An administrator can undo the merge from the contact’s page.</p>
    </div>
  );
}
