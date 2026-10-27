import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

/**
 * Mini-wrapper ECharts : init paresseux (le div peut apparaître après le mount),
 * met à jour l'option, gère le resize via ResizeObserver (nécessaire quand un
 * bloc est redimensionné par react-grid-layout) + dispose.
 */
export function useEChart(option: echarts.EChartsOption | null): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!option || !ref.current) return;
    if (!chartRef.current) {
      chartRef.current = echarts.init(ref.current);
    }
    chartRef.current.setOption(option, true);
  }, [option]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => chartRef.current?.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  return ref;
}
