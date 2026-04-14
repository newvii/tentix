import { useTransferModal } from "@modal/use-transfer-modal";
import { useUpdatePriorityModal } from "@modal/use-update-priority-modal";
import { useTranslation } from "i18n";
import {
  PanelLeft,
  TriangleAlertIcon,
  LibraryBigIcon,
  NavigationIcon,
  ExternalLink,
} from "lucide-react";
import { type TicketType } from "tentix-server/rpc";
import { updateTicketStatus, ticketsQueryOptions } from "@lib/query";
import {
  Button,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  toast,
  PriorityBadge,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "tentix-ui";
import { useQueryClient, useMutation, useQuery } from "@tanstack/react-query";
import { useState, useCallback, useEffect } from "react";
import useLocalUser from "@hook/use-local-user.tsx";
import { useChatStore } from "@store/index";
import { myFetch } from "@lib/api-client";

interface SiteHeaderProps {
  ticket: TicketType;
  sidebarVisible?: boolean;
  toggleSidebar?: () => void;
}

interface ZenTaoProduct {
  id: number;
  name: string;
}

export function StaffSiteHeader({
  ticket,
  sidebarVisible,
  toggleSidebar,
}: SiteHeaderProps) {
  const { openTransferModal, transferModal, isTransferring } =
    useTransferModal();
  const { openUpdatePriorityModal, updatePriorityModal, isUpdatingPriority } =
    useUpdatePriorityModal();

  const queryClient = useQueryClient();
  const [showDialog, setShowDialog] = useState(false);
  const [showZentaoDialog, setShowZentaoDialog] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState<string>("");
  const [bugPri, setBugPri] = useState("3");
  const [bugSeverity, setBugSeverity] = useState("3");
  const [bugType, setBugType] = useState("codeerror");
  const [bugId, setBugId] = useState<number | null>(null);

  // 当工单切换时，同步更新 bugId
  const existingZentaoBugId = ticket?.ticketHistory?.find(
    (h: any) => h.type === "transfer" && typeof h.meta === "number"
  )?.meta;

  useEffect(() => {
    setBugId(existingZentaoBugId || null);
  }, [existingZentaoBugId]);
  const { t } = useTranslation();
  const { role } = useLocalUser();
  const notCustomer = role !== "customer";
  const { kbSelectionMode, setKbSelectionMode, clearKbSelection } = useChatStore();

  // 获取禅道产品列表
  const { data: products, isLoading: isLoadingProducts } = useQuery({
    queryKey: ["zentaoProducts"],
    queryFn: async () => {
      const res = await myFetch
        .post("/api/ticket/zentao/products")
        .json<{ products: ZenTaoProduct[] }>();
      return res.products || [];
    },
    staleTime: 5 * 60 * 1000,
    enabled: false,
  });

  // 创建禅道 bug
  const createZentaoBug = useMutation({
    mutationFn: async ({
      ticketId,
      productId,
      pri,
      severity,
      type,
    }: {
      ticketId: string;
      productId: number;
      pri: number;
      severity: number;
      type: string;
    }) => {
      const res = await myFetch
        .post("/api/ticket/zentao/create-bug", {
          json: { ticketId, productId, pri, severity, type, openedBuild: ["trunk"] },
        })
        .json<{ success: boolean; bugId: number; error?: string }>();
      if (res.error) throw new Error(res.error);
      return res;
    },
    onSuccess: (data) => {
      setBugId(data.bugId);
      setShowZentaoDialog(false);
      toast({
        title: t("success"),
        description: `禅道 Bug #${data.bugId} 创建成功`,
        variant: "default",
      });
      // 更新工单状态为处理中
      updateTicketStatus({
        ticketId: ticket.id,
        status: "in_progress",
        description: "已转禅道创建 Bug",
      }).then(() => {
        queryClient.invalidateQueries({
          queryKey: ["getTicket", ticket?.id],
        });
      }).catch((e) => {
        console.error("Failed to update ticket status:", e);
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("error"),
        description: error.message || "创建禅道 bug 失败",
        variant: "destructive",
      });
    },
  });

  // Close ticket mutation
  const closeTicketMutation = useMutation({
    mutationFn: updateTicketStatus,
    onSuccess: (data) => {
      toast({
        title: t("success"),
        description: data.message || t("ticket_closed"),
        variant: "default",
      });
      // refresh user's ticket data
      queryClient.invalidateQueries({
        queryKey: ["getUserTickets"],
      });
      queryClient.invalidateQueries({
        queryKey: ["getTicket", ticket?.id],
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("error"),
        description: error.message || t("failed_close_ticket"),
        variant: "destructive",
      });
    },
  });

  // Handle close ticket
  const handleCloseTicket = useCallback(
    (ticketId: string) => {
      closeTicketMutation.mutate({
        ticketId,
        status: "resolved",
        description: t("close_ticket"),
      });
    },
    [closeTicketMutation, t],
  );

  const isResolved = ticket?.status === "resolved";

  const handleDialogConfirm = () => {
    if (ticket) {
      handleCloseTicket(ticket.id);
    }
    setShowDialog(false);
  };

  const handleDialogCancel = () => {
    setShowDialog(false);
  };

  const extractTextFromDescription = (desc: any): string => {
    if (typeof desc === "string") return desc;
    if (desc && typeof desc === "object") {
      const extract = (node: any): string => {
        if (!node) return "";
        if (typeof node === "string") return node;
        if (node.content) return node.content.map(extract).join("");
        if (node.text) return node.text;
        return "";
      };
      return extract(desc).trim();
    }
    return "";
  };

  const handleOpenZentaoDialog = () => {
    setShowZentaoDialog(true);
    setSelectedProductId("");
    setBugPri("3");
    setBugSeverity("3");
    setBugType("codeerror");
    setBugId(null);
    // 加载产品列表
    queryClient.fetchQuery({
      queryKey: ["zentaoProducts"],
      queryFn: async () => {
        const res = await myFetch
          .post("/api/ticket/zentao/products")
          .json<{ products: ZenTaoProduct[] }>();
        return res.products || [];
      },
    });
  };

  const handleCreateBug = () => {
    if (!selectedProductId) {
      toast({
        title: t("error"),
        description: "请选择禅道产品",
        variant: "destructive",
      });
      return;
    }
    createZentaoBug.mutate({
      ticketId: ticket.id,
      productId: Number(selectedProductId),
      pri: Number(bugPri),
      severity: Number(bugSeverity),
      type: bugType,
    });
  };

  const handleOpenBugPage = () => {
    if (bugId) {
      window.open(
        `http://172.22.16.52/zentaopms/www/bug-view-${bugId}.html`,
        "_blank",
      );
    }
  };

  return (
    <header className="hidden md:flex h-14 w-full border-b items-center justify-between px-4 ">
      <div className="flex items-center gap-1">
        {toggleSidebar && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 justify-center items-center rounded-md cursor-pointer hidden xl:flex"
            onClick={toggleSidebar}
            aria-label={sidebarVisible ? t("hide_sidebar") : t("show_sidebar")}
          >
            <PanelLeft className="h-5 w-5" />
          </Button>
        )}
        <h1
          className="max-w-100 2xl:max-w-100 xl:max-w-100 lg:max-w-60 md:max-w-40 sm:max-w-20 truncate block
                       text-[#000]
                       text-[16px]
                       font-[600]
                       leading-[100%]"
        >
          {ticket.title}
        </h1>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center h-10 rounded-lg border border-zinc-200">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                className="flex items-center justify-center h-10 rounded-r-none border-l-0 rounded-l-lg border-r border-zinc-200 hover:bg-zinc-50"
                onClick={() => {
                  if (kbSelectionMode) {
                    // 再次点击时关闭
                    clearKbSelection();
                    setKbSelectionMode(false);
                  } else {
                    // 打开选择模式并清空已选
                    clearKbSelection();
                    setKbSelectionMode(true);
                  }
                }}
                disabled={!notCustomer}
              >
                <LibraryBigIcon
                  className="h-3 w-3 text-zinc-500"
                  strokeWidth={1.33}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={2}>
              <p>{t("klg_base")}</p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                className="flex items-center justify-center h-10 rounded-none border-l-0  border-r-0 hover:bg-zinc-50"
                onClick={() => {}}
                disabled={false}
              >
                <NavigationIcon
                  className="h-3 w-3 text-zinc-500"
                  strokeWidth={1.33}
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={2}>
              <p>{t("raise_request")}</p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                className="flex items-center justify-center h-10 rounded-l-none border-l border-r-0 rounded-r-lg border-zinc-200 hover:bg-zinc-50"
                onClick={() =>
                  openUpdatePriorityModal(
                    ticket.id,
                    ticket.title,
                    ticket.priority,
                  )
                }
                disabled={isUpdatingPriority}
              >
                <PriorityBadge
                  priority={ticket.priority}
                  textSize="text-[12px]"
                  textSize2="text-[8px]"
                  height="h-[20px]"
                  width="w-[37px]"
                  width2="w-[35px]"
                />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={2}>
              <p>{t("set_prty")}</p>
            </TooltipContent>
          </Tooltip>
        </div>
        <div className="flex items-center h-10 rounded-lg border border-zinc-200">
          <Button
            variant="outline"
            className="flex items-center justify-center h-10 rounded-r-none border-l-0 rounded-l-lg border-r border-zinc-200 hover:bg-zinc-50"
            disabled={isResolved || closeTicketMutation.isPending}
            onClick={() => setShowDialog(true)}
          >
            {t("close")}
          </Button>
          <Button
            variant="outline"
            className="flex items-center justify-center h-10 rounded-l-none border-l-0 border-r-0 rounded-r-lg border-zinc-200 hover:bg-zinc-50"
            disabled={isTransferring}
            onClick={() => openTransferModal(ticket.id)}
          >
            {t("transfer")}
          </Button>
        </div>
        <div className="flex items-center">
          {!bugId && !isResolved && (
            <Button
              variant="outline"
              className="flex items-center justify-center h-10 rounded-lg border-zinc-200 hover:bg-zinc-50"
              onClick={handleOpenZentaoDialog}
            >
              {t("transfer_zentao")}
            </Button>
          )}
          {bugId && !isResolved && (
            <Button
              variant="outline"
              className="flex items-center justify-center h-10 rounded-lg border-zinc-200 hover:bg-zinc-50 gap-1"
              onClick={handleOpenBugPage}
            >
              {t("zentao_bug")} #{bugId}
              <ExternalLink className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
      {transferModal}
      {updatePriorityModal}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="w-96 p-6">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-1.5">
              <TriangleAlertIcon className="!h-4 !w-4 text-yellow-600" />
              {t("prompt")}
            </DialogTitle>
            <DialogDescription>
              {t("are_you_sure_close_ticket")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={handleDialogCancel}>
              {t("cancel")}
            </Button>
            <Button
              onClick={handleDialogConfirm}
              disabled={closeTicketMutation.isPending}
            >
              {closeTicketMutation.isPending ? "..." : t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ZenTao Dialog */}
      <Dialog open={showZentaoDialog} onOpenChange={setShowZentaoDialog}>
        <DialogContent className="w-96 p-6">
          <DialogHeader>
            <DialogTitle>{t("transfer_zentao_title")}</DialogTitle>
            <DialogDescription>
              {t("transfer_zentao_desc", { id: ticket.id })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <div className="text-sm font-medium mb-2">{t("zentao_product")}</div>
              <Select value={selectedProductId} onValueChange={setSelectedProductId}>
                <SelectTrigger>
                  <SelectValue placeholder={t("zentao_product_ph")} />
                </SelectTrigger>
                <SelectContent>
                  {isLoadingProducts ? (
                    <div className="p-2 text-sm text-gray-500">{t("loading")}</div>
                  ) : (
                    products?.map((p) => (
                      <SelectItem key={p.id} value={String(p.id)}>
                        {p.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-sm font-medium mb-2">{t("zentao_pri")}</div>
                <Select value={bugPri} onValueChange={setBugPri}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1-{t("urgent")}</SelectItem>
                    <SelectItem value="2">2-{t("high")}</SelectItem>
                    <SelectItem value="3">3-{t("normal")}</SelectItem>
                    <SelectItem value="4">4-{t("low")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <div className="text-sm font-medium mb-2">{t("zentao_severity")}</div>
                <Select value={bugSeverity} onValueChange={setBugSeverity}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1-{t("urgent")}</SelectItem>
                    <SelectItem value="2">2-{t("high")}</SelectItem>
                    <SelectItem value="3">3-{t("medium")}</SelectItem>
                    <SelectItem value="4">4-{t("low")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <div className="text-sm font-medium mb-2">{t("zentao_type")}</div>
              <Select value={bugType} onValueChange={setBugType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="codeerror">代码错误</SelectItem>
                  <SelectItem value="config">配置相关</SelectItem>
                  <SelectItem value="install">安装部署</SelectItem>
                  <SelectItem value="security">安全相关</SelectItem>
                  <SelectItem value="performance">性能问题</SelectItem>
                  <SelectItem value="standard">标准规范</SelectItem>
                  <SelectItem value="automation">测试脚本</SelectItem>
                  <SelectItem value="designdefect">设计缺陷</SelectItem>
                  <SelectItem value="others">其他</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <div className="text-sm font-medium mb-2">{t("zentao_steps")}</div>
              <div className="text-sm text-gray-700 bg-gray-50 rounded-md p-2 max-h-20 overflow-y-auto">
                {extractTextFromDescription(ticket.description) || "无描述"}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowZentaoDialog(false)}>
              {t("cancel")}
            </Button>
            <Button
              onClick={handleCreateBug}
              disabled={createZentaoBug.isPending}
            >
              {createZentaoBug.isPending ? "..." : t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </header>
  );
}
