import { useMemo } from "react";

import { useQuery } from "@tanstack/react-query";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";

import { listObjectTypes, searchRuntimeObjects } from "./generated/sdk.gen.ts";
import type {
  ObjectTypeMetadata,
  RuntimeObject,
} from "./generated/types.gen.ts";
import "./runtime-client.ts";
import "./styles.css";

const candidateProjectId = "44000000-0000-4000-8000-000000000001";
const columnHelper = createColumnHelper<RuntimeObject>();

export function App(): React.JSX.Element {
  const metadata = useQuery({
    queryKey: ["runtime-metadata", candidateProjectId],
    queryFn: async () => {
      const response = await listObjectTypes({
        path: { projectId: candidateProjectId },
        throwOnError: true,
      });
      return response.data;
    },
  });
  const selectedType = metadata.data?.data[0];
  const page = useQuery({
    queryKey: ["runtime-page", candidateProjectId, selectedType?.apiName],
    enabled: selectedType !== undefined,
    queryFn: async () => {
      const objectType = required(selectedType);
      const response = await searchRuntimeObjects({
        path: {
          projectId: candidateProjectId,
          objectTypeApiName: objectType.apiName,
        },
        body: {
          select: objectType.properties.map(({ apiName }) => apiName),
          pageSize: 25,
          sortDirection: "asc",
        },
        throwOnError: true,
      });
      return response.data;
    },
  });

  return (
    <main className="shell">
      <header>
        <p className="eyebrow">G2-03-01 · compile-only consumer</p>
        <h1>Runtime Read Contract Candidate</h1>
        <p>
          该消费者只认识 OpenAPI 生成类型和运行时 Metadata，不导入 Kernel 内部包，也不写死领域字段。
        </p>
      </header>

      {metadata.isPending ? <Status role="status">正在读取可见类型…</Status> : null}
      {metadata.isError ? (
        <Status role="alert">候选 API 当前不可连接；编译合同仍由 Gate 验证。</Status>
      ) : null}
      {selectedType === undefined ? null : (
        <section aria-labelledby="object-grid-heading">
          <h2 id="object-grid-heading">{selectedType.displayName}</h2>
          {page.isPending ? <Status role="status">正在读取对象…</Status> : null}
          {page.isError ? <Status role="alert">对象读取失败，未回退到手写 DTO。</Status> : null}
          <MetadataGrid metadata={selectedType} rows={page.data?.data ?? []} />
          <ObjectDetail metadata={selectedType} row={page.data?.data[0]} />
        </section>
      )}
    </main>
  );
}

function MetadataGrid({
  metadata,
  rows,
}: Readonly<{
  metadata: ObjectTypeMetadata;
  rows: readonly RuntimeObject[];
}>): React.JSX.Element {
  const columns = useMemo(
    () => [
      columnHelper.accessor("primaryKey", { header: "主键" }),
      ...metadata.properties.map((property) =>
        columnHelper.accessor(
          (row) => {
            const value = row.properties[property.apiName];
            if (value === undefined || value.disposition === "restricted") return "受限";
            if (value.disposition === "mask") return "••••";
            return value.value === null ? "—" : String(value.value);
          },
          { id: property.apiName, header: property.displayName },
        ),
      ),
    ],
    [metadata],
  );
  const table = useReactTable({ data: [...rows], columns, getCoreRowModel: getCoreRowModel() });
  return (
    <div className="table-scroll" tabIndex={0} aria-label={`${metadata.displayName} 对象表格`}>
      <table>
        <caption>{metadata.displayName}，共 {rows.length} 条当前页记录</caption>
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => (
                <th key={header.id} scope="col">
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id}>
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ObjectDetail({
  metadata,
  row,
}: Readonly<{
  metadata: ObjectTypeMetadata;
  row: RuntimeObject | undefined;
}>): React.JSX.Element | null {
  if (row === undefined) return null;
  return (
    <aside aria-labelledby="object-detail-heading">
      <h3 id="object-detail-heading">对象详情</h3>
      <dl>
        {metadata.properties.map((property) => {
          const value = row.properties[property.apiName];
          return (
            <div key={property.apiName}>
              <dt>{property.displayName}</dt>
              <dd>
                {value === undefined || value.disposition === "restricted"
                  ? "受限"
                  : value.disposition === "mask"
                    ? "••••"
                    : String(value.value ?? "—")}
              </dd>
            </div>
          );
        })}
      </dl>
    </aside>
  );
}

function Status({
  role,
  children,
}: Readonly<{ role: "alert" | "status"; children: React.ReactNode }>): React.JSX.Element {
  return <p role={role}>{children}</p>;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Candidate metadata is required.");
  return value;
}
