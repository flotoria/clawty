export interface IMessage {
  rowId: number;
  text: string;
  sender: string;
  date: Date;
  isFromMe: boolean;
  service: string;
  chatId: string | null;
}
