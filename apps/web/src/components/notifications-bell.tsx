import type { Notification } from '@repo/api-client';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@repo/ui/components/dropdown-menu';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { formatDistanceToNow } from 'date-fns';
import { Bell } from 'lucide-react';
import { Fragment, useState } from 'react';

import { tsr } from '~/lib/api';

const UNREAD_POLL_MS = 30_000;

function NotificationsBell({ organizationId }: { organizationId?: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const orgQuery = organizationId ? { organizationId } : {};

  const unreadQuery = tsr.getNotificationUnreadCount.useQuery({
    queryKey: ['notifications', 'unread-count', organizationId ?? null],
    queryData: { query: orgQuery },
    refetchInterval: UNREAD_POLL_MS,
  });

  const listQuery = tsr.listNotifications.useQuery({
    queryKey: ['notifications', 'list', organizationId ?? null],
    queryData: { query: { ...orgQuery, limit: 20 } },
    enabled: open,
  });

  const markRead = tsr.markNotificationRead.useMutation({
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  const unreadCount = unreadQuery.data?.status === 200 ? unreadQuery.data.body.count : 0;
  const notifications = listQuery.data?.status === 200 ? listQuery.data.body : [];
  const hasUnread = unreadCount > 0;
  const badgeLabel = unreadCount > 9 ? '9+' : String(unreadCount);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
  };

  const handleClick = (notification: Notification) => {
    if (!notification.readAt) {
      markRead.mutate({ params: { id: notification.id }, body: {} });
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant={hasUnread ? 'default' : 'ghost'}
          size="icon"
          className={
            hasUnread
              ? 'bg-primary text-primary-foreground hover:bg-primary/90 relative h-9 w-9 shrink-0 overflow-visible'
              : 'relative h-8 w-8 shrink-0'
          }
          aria-label={hasUnread ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        >
          <Bell className="h-4 w-4" />
          {hasUnread ? (
            <Badge
              variant="destructive"
              size="sm"
              className="bg-destructive absolute -top-1 -right-1 z-10 min-w-5 justify-center border-0 px-1.5 py-0 text-[11px] leading-4 text-white shadow-sm"
            >
              {badgeLabel}
            </Badge>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="w-80">
        <DropdownMenuLabel className="font-mono text-xs">Notifications</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {listQuery.isPending ? (
          <div className="text-muted-foreground px-2 py-6 text-center text-sm">Loading…</div>
        ) : notifications.length === 0 ? (
          <div className="text-muted-foreground px-2 py-6 text-center text-sm">No notifications</div>
        ) : (
          <div className="max-h-[360px] overflow-y-auto">
            {notifications.map((notification, index) => {
              const content = (
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex items-start justify-between gap-2">
                    <span
                      className={`break-words whitespace-normal ${notification.readAt ? 'font-medium' : 'font-semibold'}`}
                    >
                      {notification.title}
                    </span>
                    {!notification.readAt ? <span className="bg-accent mt-1 size-1.5 shrink-0 rounded-full" /> : null}
                  </div>
                  <span className="text-muted-foreground text-xs break-words whitespace-normal">
                    {notification.body}
                  </span>
                  <span className="text-muted-foreground text-[10px]">
                    {formatDistanceToNow(new Date(notification.createdAt), { addSuffix: true })}
                  </span>
                </div>
              );

              const item = notification.href ? (
                <DropdownMenuItem className="cursor-pointer items-start rounded-none p-2" asChild>
                  <Link to={notification.href} onClick={() => handleClick(notification)}>
                    {content}
                  </Link>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  className="cursor-pointer items-start rounded-none p-2"
                  onClick={() => handleClick(notification)}
                >
                  {content}
                </DropdownMenuItem>
              );

              return (
                <Fragment key={notification.id}>
                  {index > 0 ? <DropdownMenuSeparator className="my-0" /> : null}
                  {item}
                </Fragment>
              );
            })}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { NotificationsBell };
