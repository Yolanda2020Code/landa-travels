import { useEffect, useMemo, useState } from "react";
import { Award, Star, ShieldCheck, Map, Share2, Download, Copy, Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useGetCurrentProfile, useGetRewardSummary } from "@workspace/api-client-react";

type ShareStatus = "idle" | "generating" | "ready" | "shared" | "copied" | "downloaded" | "cancelled" | "error";

function createMissionCard(level: string, totalPoints: number, evidenceCount: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 630;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image generation is unavailable");

  const gradient = context.createLinearGradient(0, 0, 1200, 630);
  gradient.addColorStop(0, "#07111d");
  gradient.addColorStop(0.55, "#0b1724");
  gradient.addColorStop(1, "#07333c");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1200, 630);

  context.globalAlpha = 0.16;
  context.fillStyle = "#13d7ec";
  context.beginPath();
  context.arc(1030, 95, 270, 0, Math.PI * 2);
  context.fill();
  context.globalAlpha = 1;

  context.strokeStyle = "rgba(19,215,236,.28)";
  context.lineWidth = 2;
  context.beginPath();
  context.roundRect(48, 48, 1104, 534, 28);
  context.stroke();

  context.fillStyle = "#13d7ec";
  context.beginPath();
  context.roundRect(74, 72, 62, 62, 18);
  context.fill();
  context.strokeStyle = "#07111d";
  context.lineWidth = 5;
  context.beginPath();
  context.moveTo(93, 113);
  context.bezierCurveTo(104, 88, 127, 91, 120, 111);
  context.bezierCurveTo(113, 127, 94, 125, 93, 113);
  context.stroke();

  context.fillStyle = "#f5f8fb";
  context.font = "700 30px Georgia, serif";
  context.fillText("Landa Travels", 156, 105);
  context.fillStyle = "#13d7ec";
  context.font = "700 14px Arial, sans-serif";
  context.letterSpacing = "3px";
  context.fillText("RESPONSIBLE JOURNEYS", 158, 130);

  context.fillStyle = "#9aabbc";
  context.font = "700 16px Arial, sans-serif";
  context.fillText("MY MISSION CARD", 76, 206);
  context.fillStyle = "#f5f8fb";
  context.font = "700 68px Georgia, serif";
  context.fillText(level, 74, 285);
  context.fillStyle = "#b9c5d1";
  context.font = "400 25px Arial, sans-serif";
  context.fillText("Recognising documented lower-impact choices", 76, 330);

  const metrics = [
    { value: String(totalPoints), label: "DOCUMENTED POINTS", x: 76 },
    { value: String(evidenceCount), label: "EVIDENCE RECORDS", x: 370 },
  ];
  metrics.forEach(({ value, label, x }) => {
    context.fillStyle = "rgba(255,255,255,.055)";
    context.beginPath();
    context.roundRect(x, 374, 260, 112, 20);
    context.fill();
    context.fillStyle = "#13d7ec";
    context.font = "700 38px Arial, sans-serif";
    context.fillText(value, x + 22, 423);
    context.fillStyle = "#9aabbc";
    context.font = "700 13px Arial, sans-serif";
    context.fillText(label, x + 22, 458);
  });

  context.fillStyle = "#9aabbc";
  context.font = "400 17px Arial, sans-serif";
  context.fillText("Points recognise documented choices; they are not verified emissions savings.", 76, 545);
  context.fillStyle = "#f5f8fb";
  context.font = "700 22px Arial, sans-serif";
  context.fillText("landa.travel", 955, 536);

  return canvas.toDataURL("image/png");
}

export default function Rewards() {
  const { data: summary, isLoading } = useGetRewardSummary();
  const { data: profile } = useGetCurrentProfile();
  const { toast } = useToast();
  const evidenceCount = summary?.events?.filter((event) => event.evidence.trim().length > 0).length || 0;
  const [shareOpen, setShareOpen] = useState(false);
  const [shareStatus, setShareStatus] = useState<ShareStatus>("idle");
  const [cardImage, setCardImage] = useState("");
  const level = summary?.level || "First steps";
  const totalPoints = summary?.totalPoints || 0;
  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
  const shareUrl = useMemo(() => `${window.location.origin}${basePath}/about?mission=${encodeURIComponent(level)}`, [basePath, level]);
  const shareText = `I reached the ${level} journey level with ${totalPoints} documented points on Landa Travels. Points recognise recorded lower-impact choices; they are not verified emissions savings.`;

  useEffect(() => {
    if (!shareOpen) return;
    setShareStatus("generating");
    try {
      setCardImage(createMissionCard(level, totalPoints, evidenceCount));
      setShareStatus("ready");
    } catch {
      setShareStatus("error");
    }
  }, [shareOpen, level, totalPoints, evidenceCount]);

  const imageFile = async () => {
    const blob = await (await fetch(cardImage)).blob();
    return new File([blob], "landa-mission-card.png", { type: "image/png" });
  };

  const handleNativeShare = async () => {
    if (!navigator.share) {
      setShareStatus("error");
      toast({ title: "Native sharing is not supported here", description: "Download the image or copy the mission link instead." });
      return;
    }
    try {
      const file = await imageFile();
      const shareData: ShareData = { title: "My Landa Travels mission card", text: shareText, url: shareUrl };
      if (navigator.canShare?.({ files: [file] })) shareData.files = [file];
      await navigator.share(shareData);
      setShareStatus("shared");
      toast({ title: "Mission card shared", description: "Your privacy-safe mission summary was shared." });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setShareStatus("cancelled");
        return;
      }
      setShareStatus("error");
      toast({ title: "Sharing failed", description: "Download the image or copy the mission link instead.", variant: "destructive" });
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(`${shareText}\n${shareUrl}`);
      setShareStatus("copied");
      toast({ title: "Mission link copied", description: "The share text and trusted Landa link are ready to paste." });
    } catch {
      setShareStatus("error");
      toast({ title: "Copy failed", description: "Your browser blocked clipboard access. You can still download the image.", variant: "destructive" });
    }
  };

  const downloadCard = () => {
    if (!cardImage) return;
    const link = document.createElement("a");
    link.href = cardImage;
    link.download = "landa-mission-card.png";
    link.click();
    setShareStatus("downloaded");
    toast({ title: "Mission card downloaded", description: "The PNG contains no private trip details." });
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="animate-spin text-primary"><Star size={32} /></div>
      </div>
    );
  }

  const isTopTier = summary?.nextLevelPoints === 0;
  const levelColor = isTopTier ? 'text-yellow-500' : summary?.level === 'Wayfinder' ? 'text-gray-300' : 'text-amber-600';
  const targetPoints = isTopTier ? summary?.totalPoints || 0 : summary?.nextLevelPoints || 200;
  const progress = isTopTier ? 100 : Math.min(100, ((summary?.totalPoints || 0) / targetPoints) * 100);

  return (
    <div className="flex-1 p-4 md:p-8 max-w-6xl mx-auto w-full space-y-8 animate-fade-in-up">
      <div className="flex flex-col md:flex-row gap-6 justify-between items-start md:items-center">
        <div>
          <h1 className="text-3xl font-serif font-bold tracking-tight">Impact & Rewards</h1>
          <p className="text-muted-foreground mt-2 text-lg">Points for documented lower-impact choices, with evidence and clear limits.</p>
        </div>
        <Button variant="outline" onClick={() => setShareOpen(true)} className="gap-2 rounded-full font-semibold border-primary/20 hover:bg-primary/5">
          <Share2 size={16} /> Share Mission Card
        </Button>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        <Card className="md:col-span-2 bg-gradient-to-br from-card to-card/50 border-border/50 shadow-lg relative overflow-hidden">
          <div className="absolute top-0 right-0 p-12 opacity-5 pointer-events-none">
            <Award size={200} />
          </div>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl font-serif">
              <Award className={levelColor} size={24} /> 
              Status: <span className={levelColor}>{summary?.level || 'Bronze'}</span>
            </CardTitle>
            <CardDescription className="text-base mt-2">
              {isTopTier
                ? "You have reached the current highest journey level."
                : `You are ${Math.max(0, (summary?.nextLevelPoints || 200) - (summary?.totalPoints || 0))} points away from the next tier.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-3">
              <div className="flex justify-between text-sm font-semibold">
                <span>{summary?.totalPoints || 0} pts</span>
                <span className="text-muted-foreground">{targetPoints} pts</span>
              </div>
              <Progress value={progress} className="h-3 bg-background" />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4">
              <div className="p-4 rounded-2xl bg-background/50 border border-border/50 text-center">
                <Award size={24} className="mx-auto mb-2 text-emerald-500" />
                <div className="font-bold text-lg">{summary?.totalPoints || 0}</div>
                <div className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider mt-1">Documented Points</div>
              </div>
              <div className="p-4 rounded-2xl bg-background/50 border border-border/50 text-center">
                <ShieldCheck size={24} className="mx-auto mb-2 text-cyan-500" />
                <div className="font-bold text-lg">{evidenceCount}</div>
                <div className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider mt-1">Evidence Records</div>
              </div>
              <div className="p-4 rounded-2xl bg-background/50 border border-border/50 text-center">
                <ShieldCheck size={24} className="mx-auto mb-2 text-primary" />
                <div className="font-bold text-lg">{summary?.events?.length || 0}</div>
                <div className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider mt-1">Reward Events</div>
              </div>
              <div className="p-4 rounded-2xl bg-background/50 border border-border/50 text-center">
                <Map size={24} className="mx-auto mb-2 text-amber-500" />
                <div className="font-bold text-lg">{summary?.level || "First steps"}</div>
                <div className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider mt-1">Journey Level</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-primary/5 border-primary/20 shadow-lg">
          <CardHeader>
            <CardTitle className="font-serif text-xl">Mission Card</CardTitle>
            <CardDescription>A privacy-safe badge you can preview before sharing.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col items-center justify-center text-center p-6 space-y-4">
            <div className="w-24 h-24 rounded-full bg-card border-4 border-primary shadow-[0_0_30px_rgba(0,240,255,0.3)] flex items-center justify-center overflow-hidden">
              <img src="https://api.dicebear.com/7.x/shapes/svg?seed=Landa&backgroundColor=0a0e17" alt="Avatar" className="w-full h-full object-cover" />
            </div>
            <div>
              <h3 className="font-bold text-xl font-serif">{profile?.displayName && profile.displayName.toLowerCase() !== "traveller" ? profile.displayName : "Add your name in Dashboard"}</h3>
              <p className="text-primary font-semibold text-sm mt-1">{summary?.level || 'Bronze'} Member</p>
            </div>
            <Badge variant="outline" className="bg-background font-bold px-4 py-1.5 border-primary/30">
              {summary?.totalPoints || 0} Total Points
            </Badge>
          </CardContent>
        </Card>
      </div>

      <div>
        <h2 className="text-2xl font-serif font-bold mb-6">Recent Achievements</h2>
        <div className="space-y-4">
          {summary?.events?.length ? summary.events.map((event) => (
            <div key={event.id} className="flex items-center justify-between p-5 rounded-2xl bg-card border border-border/50 hover:border-primary/30 transition-colors shadow-sm">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center text-primary shrink-0">
                  <Star size={20} />
                </div>
                <div>
                  <h4 className="font-bold text-foreground">{event.reason}</h4>
                  <p className="text-sm text-muted-foreground font-medium mt-1">{event.category} • {new Date(event.createdAt).toLocaleDateString()}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Badge variant="secondary" className="bg-background border-border/50 text-xs font-bold px-3 py-1">
                  +{event.points} pts
                </Badge>
              </div>
            </div>
          )) : (
            <div className="p-8 text-center bg-card border border-border/50 rounded-2xl text-muted-foreground">
              <Award size={48} className="mx-auto mb-4 text-muted" />
              <p className="font-medium text-lg">No achievements yet.</p>
              <p className="text-sm mt-2">Document a meaningful lower-impact choice to earn your first points. Rewards recognise evidence; they do not erase emissions.</p>
            </div>
          )}
        </div>
      </div>

      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent className="max-w-3xl rounded-3xl p-0 overflow-hidden">
          <DialogHeader className="p-6 pb-0">
            <DialogTitle className="font-serif text-2xl">Preview your mission card</DialogTitle>
            <DialogDescription>This exact image includes only your journey level, documented points, and evidence-record count—never destinations, dates, bookings, or profile details.</DialogDescription>
          </DialogHeader>
          <div className="p-6 space-y-5">
            <div className="aspect-[1200/630] rounded-2xl border border-border/60 bg-muted/40 overflow-hidden flex items-center justify-center">
              {shareStatus === "generating" && <Loader2 className="animate-spin text-primary" size={32}/>}
              {cardImage && <img src={cardImage} alt={`Landa Travels mission card showing ${level} level, ${totalPoints} documented points, and ${evidenceCount} evidence records`} className="w-full h-full object-cover"/>}
            </div>
            <div className="rounded-2xl border border-border/60 bg-muted/30 p-4">
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground mb-2">Text shared with the image</p>
              <p className="text-sm leading-relaxed">{shareText}</p>
              <p className="text-xs text-primary mt-2 break-all">{shareUrl}</p>
            </div>
            {shareStatus === "cancelled" && <p role="status" className="text-sm text-muted-foreground">Sharing was cancelled. Nothing was posted.</p>}
            {["shared", "copied", "downloaded"].includes(shareStatus) && <p role="status" className="flex items-center gap-2 text-sm text-emerald-400"><CheckCircle2 size={16}/> Action completed successfully.</p>}
            <div className="grid sm:grid-cols-3 gap-3">
              <Button onClick={handleNativeShare} disabled={!cardImage || shareStatus === "generating"} className="gap-2"><Share2 size={16}/> Share</Button>
              <Button variant="outline" onClick={downloadCard} disabled={!cardImage} className="gap-2"><Download size={16}/> Download PNG</Button>
              <Button variant="outline" onClick={copyLink} className="gap-2"><Copy size={16}/> Copy link</Button>
            </div>
            <p className="text-xs text-muted-foreground text-center">Illustrative points recognise documented actions. They do not prove emissions avoided or make a journey impact-free.</p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
