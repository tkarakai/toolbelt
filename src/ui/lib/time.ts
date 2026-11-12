export function elapsedTime(ms: number) {
  if (ms < 60000) return "just now";
  const minutes = Math.floor(ms / 60000);
  const count = minutes >= 1440 ? Math.floor(minutes / 1440) : minutes >= 60 ? Math.floor(minutes / 60) : minutes;
  const unit = minutes >= 1440 ? "day" : minutes >= 60 ? "hour" : "minute";
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}
