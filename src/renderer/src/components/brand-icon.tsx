import type { ComponentPropsWithoutRef } from 'react';

import iconUrl from '@/assets/hemi-icon.svg';

/** 所有界面品牌入口共用同一张图；尺寸属性预留布局，空 alt 默认作装饰。 */
export function BrandIcon({
  className = '',
  alt = '',
  width = 24,
  height = 24,
  ...props
}: Omit<ComponentPropsWithoutRef<'img'>, 'src'>) {
  return (
    <img
      {...props}
      src={iconUrl}
      className={`hemi-brand-icon ${className}`.trim()}
      alt={alt}
      width={width}
      height={height}
      draggable={false}
    />
  );
}
