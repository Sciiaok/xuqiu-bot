import s from './DataTable.module.css';

/**
 * @param {object} props
 * @param {string[]} props.columns - header labels
 * @param {Array<Array<React.ReactNode>>} props.rows
 * @param {number} [props.selectedIndex]
 * @param {function} [props.onRowClick]
 */
export default function DataTable({ columns, rows, selectedIndex, onRowClick }) {
  return (
    <table className={s.table}>
      <thead>
        <tr>{columns.map((col, i) => <th key={i}>{col}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr
            key={ri}
            className={selectedIndex === ri ? s.selected : ''}
            onClick={() => onRowClick?.(ri)}
          >
            {row.map((cell, ci) => <td key={ci}>{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
