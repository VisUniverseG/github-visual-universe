import type { BranchItem } from '../../github/activity.ts';

interface Props {
  readonly branches: readonly BranchItem[];
  /** The default branch from the repository list, or `null` when it is not known. */
  readonly defaultBranch: string | null;
}

function protectedText(value: boolean | null): string {
  if (value === null) return 'Unknown';
  return value ? 'Yes' : 'No';
}

/** The loaded branches. Names come from the repository and are shown as plain text only. */
export function BranchTable({ branches, defaultBranch }: Props) {
  return (
    <table className="activity-table">
      <caption className="visually-hidden">Loaded branches</caption>
      <thead>
        <tr>
          <th scope="col">Branch</th>
          <th scope="col">Protected</th>
          <th scope="col">Head commit</th>
        </tr>
      </thead>
      <tbody>
        {branches.map((branch, index) => (
          // Display-safe names can coincide (they differ only in characters that were replaced).
          <tr key={`${branch.name}:${String(index)}`}>
            <th scope="row" className="activity-subject">
              {branch.name}
              {defaultBranch !== null && branch.name === defaultBranch && (
                <>
                  {' '}
                  <span className="badge">Default</span>
                </>
              )}
            </th>
            <td>{protectedText(branch.isProtected)}</td>
            <td>
              <code>{branch.headSha.slice(0, 7)}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
