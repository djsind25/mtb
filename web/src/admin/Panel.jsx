import { C } from "../theme";

export function Panel({ title, subtitle, action, children, className = "" }) {
  return (
    <section className={`admin-panel ${className}`.trim()}>
      <div className="admin-panel__header">
        <div>
          <div style={{ fontSize: 14, fontWeight: 750, color: C.pineDeep }}>{title}</div>
          {subtitle && <div className="admin-panel__subtitle">{subtitle}</div>}
        </div>
        {action && <div className="admin-panel__action">{action}</div>}
      </div>
      {children}
    </section>
  );
}
