import { Render } from "./Render";
import { RendererBoundary } from "./Boundary";
export function SafeRender(props: Parameters<typeof Render>[0]) {
  return (
    <RendererBoundary resetKey={props.node}>
      <Render {...props} />
    </RendererBoundary>
  );
}
