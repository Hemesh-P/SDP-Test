'use client';

import dynamic from 'next/dynamic';
import type { EChartsOption } from 'echarts';
import type { MetricsResponse } from '@rat/contracts';
import { Card } from '@rat/ui';

const ReactECharts = dynamic(() => import('echarts-for-react'), { ssr: false });

export function ActivityChart({ series }: { series: MetricsResponse['series'] }) {
  const option: EChartsOption = {
    backgroundColor: 'transparent',
    color: ['#22d3ee', '#fb7185'],
    tooltip: { trigger: 'axis' },
    legend: { textStyle: { color: '#94a3b8' } },
    grid: { left: 20, right: 20, top: 50, bottom: 25, containLabel: true },
    xAxis: {
      type: 'category',
      data: series.map((item) => item.label),
      axisLabel: { color: '#64748b', hideOverlap: true },
      axisLine: { lineStyle: { color: '#334155' } },
    },
    yAxis: {
      type: 'value',
      axisLabel: { color: '#64748b' },
      splitLine: { lineStyle: { color: '#1e293b' } },
    },
    series: [
      {
        name: 'Added',
        type: 'bar',
        stack: 'lines',
        data: series.map((item) => Number(item.added)),
        itemStyle: { borderRadius: [3, 3, 0, 0] },
      },
      {
        name: 'Removed',
        type: 'bar',
        stack: 'lines',
        data: series.map((item) => -Number(item.removed)),
        itemStyle: { borderRadius: [0, 0, 3, 3] },
      },
    ],
  };

  return (
    <Card>
      <div className="mb-3">
        <h2 className="font-semibold text-white">Change activity</h2>
        <p className="text-sm text-slate-500">Added and removed lines over the selected commit set</p>
      </div>
      {series.length ? (
        <ReactECharts option={option} style={{ height: 340 }} />
      ) : (
        <div className="grid h-[340px] place-items-center text-sm text-slate-500">No textual changes in this selection</div>
      )}
      <table className="sr-only">
        <caption>Accessible change activity data</caption>
        <thead><tr><th>Period</th><th>Added</th><th>Removed</th></tr></thead>
        <tbody>{series.map((item) => <tr key={item.key}><td>{item.label}</td><td>{item.added}</td><td>{item.removed}</td></tr>)}</tbody>
      </table>
    </Card>
  );
}

export function HotspotChart({ series }: { series: MetricsResponse['series'] }) {
  const option: EChartsOption = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'item' },
    series: [
      {
        type: 'treemap',
        roam: false,
        breadcrumb: { show: false },
        label: { color: '#f8fafc', formatter: '{b}' },
        upperLabel: { show: false },
        itemStyle: { borderColor: '#0f172a', borderWidth: 2, gapWidth: 2 },
        data: series.map((item) => {
          const growth = Number(item.growth);
          return {
            name: item.label.split('/').at(-1) || '/',
            value: Number(item.churn),
            itemStyle: { color: growth >= 0 ? '#0e7490' : '#9f1239' },
          };
        }),
      },
    ],
  };
  return (
    <Card>
      <h2 className="font-semibold text-white">Change hotspots</h2>
      <p className="text-sm text-slate-500">Area is churn; cyan is growth and rose is contraction</p>
      {series.length ? <ReactECharts option={option} style={{ height: 340 }} /> : <div className="grid h-[340px] place-items-center text-sm text-slate-500">No child objects changed</div>}
    </Card>
  );
}
